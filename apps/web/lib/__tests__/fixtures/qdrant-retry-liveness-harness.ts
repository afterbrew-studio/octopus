import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: the fake clock and patched setTimeout must not reach other tests.
mock.module("server-only", () => ({}));
process.env.QDRANT_URL = "http://localhost:6333";
let clock = 1_000_000;
Date.now = () => clock;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((callback: () => void, ms?: number, ...args: unknown[]) => {
  clock += ms ?? 0;
  return realSetTimeout(callback, 0, ...args);
}) as typeof setTimeout;

const clientOptions: Array<{ timeout?: number }> = [];
let attempts = 0;
let behavior: "fail" | "hang" = "fail";
let onAttempt: (() => void) | undefined;
mock.module("@qdrant/js-client-rest", () => ({
  QdrantClient: class {
    constructor(private readonly options: { timeout?: number }) { clientOptions.push(options); }
    async scroll() {
      attempts++;
      onAttempt?.();
      if (behavior === "hang") return new Promise(() => {});
      // Runs to its timeout before failing: the worst case.
      clock += this.options.timeout ?? 300_000;
      throw Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    }
  },
}));
mock.module("@/lib/repository-index-storage", () => ({ getActiveRepositoryCodeFilter: async () => ({ should: [] }) }));
const { scrollActiveChunkVectors } = await import("@/lib/qdrant");
const { INDEX_SILENCE_LIMIT_MS, INDEX_QDRANT_REQUEST_TIMEOUT_MS } = await import("@/lib/index-liveness");
const drain = async (signal?: AbortSignal) => { for await (const page of scrollActiveChunkVectors("repo-1", signal)) void page; };

const started = clock;
await assert.rejects(() => drain(), /fetch failed/);
assert.equal(attempts, 4);
assert.equal(clientOptions[0].timeout, INDEX_QDRANT_REQUEST_TIMEOUT_MS, "the indexing client bounds each request");
const silent = clock - started;
assert.ok(silent < INDEX_SILENCE_LIMIT_MS / 2, `a retry sequence stayed silent for ${silent}ms`);
assert.ok(4 * 300_000 >= INDEX_SILENCE_LIMIT_MS, "with the client's default timeout the same sequence would not have fit");

attempts = 0;
const between = new AbortController();
onAttempt = () => between.abort(new Error("cancelled"));
await assert.rejects(() => drain(between.signal), /cancelled/);
assert.equal(attempts, 1);

attempts = 0; behavior = "hang";
const inFlight = new AbortController();
onAttempt = () => realSetTimeout(() => inFlight.abort(new Error("stopped")), 10);
await assert.rejects(() => drain(inFlight.signal), /stopped/);
assert.equal(attempts, 1);

globalThis.setTimeout = realSetTimeout;
console.log("Qdrant retry liveness checks passed");
process.exit(0);
