import { mock } from "bun:test";
import assert from "node:assert/strict";

// Real heartbeat throttle on a fake clock: a slow operation must still produce heartbeats.
mock.module("server-only", () => ({}));
let clock = 1_000_000;
Date.now = () => clock;
const delays: number[] = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
  if (ms === 30_000) return realSetTimeout(callback, ms, ...args);
  delays.push(ms ?? 0);
  clock += ms ?? 0;
  return realSetTimeout(callback, 0, ...args);
}) as typeof setTimeout;

const touches: number[] = [];
let supersedeAfter = Infinity;
const { SupersededIndexError, INDEX_HEARTBEAT_INTERVAL_MS, INDEX_MAX_RATE_LIMIT_WAIT_MS } = await import("@/lib/index-liveness");
mock.module("@/lib/repository-index-storage", () => ({
  touchRepositoryIndex: async () => {
    touches.push(clock);
    if (touches.length > supersedeAfter) throw new SupersededIndexError();
  },
}));
mock.module("@/lib/github", () => ({ getInstallationToken: async () => "token", getRepositoryDetails: async () => null, getFileContent: async () => null }));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/forgejo", () => ({}));
mock.module("@/lib/qdrant", () => ({
  ensureCollection: async () => {}, listRepoFileChunkIds: async () => [], deleteChunkPoints: async () => {}, upsertChunks: async () => {},
  scrollActiveChunkVectors: async function* () {},
}));
mock.module("@/lib/embeddings", () => ({ resolveEmbedConfig: async () => (await import("@/lib/embed-config")).getEmbedConfig(), createEmbeddings: async (texts: string[]) => texts.map(() => [0.1]) }));
const { indexRepository } = await import("@/lib/indexer");

// 130s slices into 60/60/10, avoiding the 30s blob timeout the spy lets through untouched.
let retryAfter = "130";
let blobCalls = 0;
const signals: Record<string, AbortSignal | null | undefined> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  signals[url.includes("/trees/") ? "tree" : url.includes("/contributors") ? "contributors" : "other"] = init?.signal;
  if (url.includes("/trees/")) return Response.json({ tree: [{ path: "index.ts", type: "blob", sha: "blob-1", size: 30 }] });
  if (url.includes("/contributors")) return Response.json([]);
  blobCalls++;
  if (blobCalls === 1) return new Response("{}", { status: 429, headers: { "retry-after": retryAfter } });
  return Response.json({ encoding: "base64", content: Buffer.from("export const a = 1;\n").toString("base64") });
}) as typeof fetch;

const run = () => indexRepository({ repoId: "repo-1", indexAttemptId: "attempt-1" }, "acme/new", "main", 123);
function reset() { touches.length = 0; delays.length = 0; blobCalls = 0; supersedeAfter = Infinity; }

// A 130 second rate-limit wait is slept in heartbeat-sized slices, with a heartbeat between slices.
reset();
assert.equal((await run()).indexedFiles, 1);
assert.ok(delays.every(ms => ms <= INDEX_HEARTBEAT_INTERVAL_MS), `a single wait must not outlast the heartbeat interval: ${delays}`);
assert.equal(delays.reduce((sum, ms) => sum + ms, 0), 130_000, "the requested wait is still honored");
assert.ok(touches.length >= 2, `the wait must heartbeat, got ${touches.length}`);
for (let i = 1; i < touches.length; i++) assert.ok(touches[i] - touches[i - 1] <= INDEX_HEARTBEAT_INTERVAL_MS + 1, "heartbeats must stay within the interval");
assert.ok(signals.tree && signals.contributors, "provider requests must carry a timeout");

// An absurd Retry-After is capped.
reset(); retryAfter = "7200";
await run();
assert.ok(delays.reduce((sum, ms) => sum + ms, 0) <= INDEX_MAX_RATE_LIMIT_WAIT_MS);

// Losing the claim during the wait ends the attempt instead of sleeping on and skipping the file.
reset(); retryAfter = "130"; supersedeAfter = 1;
await assert.rejects(run, SupersededIndexError);
assert.ok(delays.reduce((sum, ms) => sum + ms, 0) < 130_000, "a superseded attempt must stop waiting");

globalThis.setTimeout = realSetTimeout;
console.log("Slow-operation heartbeat regressions passed");
