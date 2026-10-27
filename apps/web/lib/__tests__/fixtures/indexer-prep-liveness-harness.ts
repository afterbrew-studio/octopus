import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process, real heartbeat throttle on a fake clock: GitHub preparation made of several slow requests
// in a row must keep the attempt alive between them.
mock.module("server-only", () => ({}));
let clock = 1_000_000;
Date.now = () => clock;
const FOUR_MINUTES = 240_000;
const slow = () => { clock += FOUR_MINUTES; };

const touches: number[] = [];
mock.module("@/lib/repository-index-storage", () => ({ touchRepositoryIndex: async () => { touches.push(clock); } }));
const requestSignals: Array<AbortSignal | undefined> = [];
mock.module("@/lib/github", () => ({
  getInstallationToken: async () => "token",
  getRepositoryDetails: async (_id: number, _owner: string, _repo: string, _token?: string, signal?: AbortSignal) => {
    requestSignals.push(signal); slow();
    return { default_branch: "trunk" };
  },
  getFileContent: async (_id: number, _owner: string, _repo: string, _ref: string, _path: string, _token?: string, signal?: AbortSignal) => {
    requestSignals.push(signal); slow();
    return "";
  },
}));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/forgejo", () => ({}));
mock.module("@/lib/qdrant", () => ({
  ensureCollection: async () => {}, listRepoFileChunkIds: async () => [], deleteChunkPoints: async () => {}, upsertChunks: async () => {},
  scrollActiveChunkVectors: async function* () {},
}));
mock.module("@/lib/embeddings", () => ({
  resolveEmbedConfig: async () => (await import("@/lib/embed-config")).getEmbedConfig(),
  createEmbeddings: async (texts: string[]) => texts.map(() => [0.1]),
}));
const { indexRepository } = await import("@/lib/indexer");
const { INDEX_SILENCE_LIMIT_MS } = await import("@/lib/index-liveness");

// Stored branch is wrong: tree 404, repository details, corrected tree, .octopusignore, contributors: five requests of four minutes.
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/git/trees/main")) { slow(); return new Response("{}", { status: 404 }); }
  if (url.includes("/git/trees/trunk")) {
    slow();
    return Response.json({ tree: [{ path: ".octopusignore", type: "blob", sha: "ignore" }, { path: "index.ts", type: "blob", sha: "blob-1", size: 30 }] });
  }
  if (url.includes("/contributors")) { slow(); return Response.json([]); }
  return Response.json({ encoding: "base64", content: Buffer.from("export const a = 1;\n").toString("base64") });
}) as typeof fetch;

const started = clock;
const result = await indexRepository({ repoId: "repo-1", indexAttemptId: "attempt-1" }, "acme/new", "main", 123);
assert.equal(result.indexedFiles, 1);
assert.ok(clock - started >= 5 * FOUR_MINUTES, "preparation alone outlasts the silence limit");
assert.ok(clock - started > INDEX_SILENCE_LIMIT_MS);
assert.ok(touches.length >= 5, `a heartbeat after each preparation request, got ${touches.length}`);
let last = started;
for (const at of touches) { assert.ok(at - last < INDEX_SILENCE_LIMIT_MS, `silent for ${at - last}ms`); last = at; }
assert.ok(requestSignals.length === 2 && requestSignals.every(signal => signal), "repository details and the ignore file carry a deadline");
console.log("GitHub preparation liveness checks passed");
process.exit(0);
