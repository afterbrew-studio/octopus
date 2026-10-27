import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process, real heartbeat throttle on a fake clock: a slow local batch must keep its upload alive.
mock.module("server-only", () => ({}));
let clock = 1_000_000;
Date.now = () => clock;
const { INDEX_SILENCE_LIMIT_MS, SupersededIndexError } = await import("@/lib/index-liveness");

const touches: Array<{ at: number; owner: Record<string, unknown> }> = [];
let supersedeAfter = Infinity;
mock.module("@/lib/repository-index-storage", () => ({
  touchRepositoryIndex: async (owner: Record<string, unknown>) => {
    touches.push({ at: clock, owner });
    if (touches.length > supersedeAfter) throw new SupersededIndexError();
  },
}));
let upserts = 0;
mock.module("@/lib/qdrant", () => ({ upsertChunks: async () => { upserts++; clock += 30_000; } }));
mock.module("@/lib/embeddings", () => ({
  // Five provider requests of four minutes each, the way a slow CPU embedder behaves.
  createEmbeddings: async (texts: string[], _tracking: unknown, progress?: { onRequest?: () => Promise<void> }) => {
    for (let i = 0; i < 5; i++) { clock += 240_000; await progress?.onRequest?.(); }
    return texts.map(() => [0.1]);
  },
}));
const { indexLocalBatch } = await import("@/lib/index-local");

const files = Array.from({ length: 250 }, (_, i) => ({ path: `src/file${i}.ts`, content: `export const value${i} = ${i};\n` }));
const claim = { attemptId: "attempt-1", upload: { id: "upload-1" } };
const started = clock;

const result = await indexLocalBatch("repo-1", "acme/local", "org-1", files, claim);
assert.equal(result.chunksInBatch, 250);
assert.ok(clock - started > INDEX_SILENCE_LIMIT_MS, "the batch itself outlasts the silence limit");
assert.ok(touches.length >= 4, `the batch must heartbeat, got ${touches.length}`);
assert.deepEqual(touches[0].owner, { repoId: "repo-1", indexAttemptId: "attempt-1", uploadId: "upload-1" }, "heartbeats use the upload's owner");
let last = started;
for (const touch of touches) { assert.ok(touch.at - last < INDEX_SILENCE_LIMIT_MS, "no gap reaches the silence limit"); last = touch.at; }
assert.ok(clock - last < INDEX_SILENCE_LIMIT_MS);
assert.equal(upserts, 3, "upserts go out one Qdrant request at a time");

// Losing the upload during the embedding stops the batch before anything is written.
touches.length = 0; upserts = 0; supersedeAfter = 1;
await assert.rejects(() => indexLocalBatch("repo-1", "acme/local", "org-1", files, claim), SupersededIndexError);
assert.equal(upserts, 0);
console.log("Local upload liveness checks passed");
process.exit(0);
