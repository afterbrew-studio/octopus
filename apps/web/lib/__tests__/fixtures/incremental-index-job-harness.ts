import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: the module mocks must not reach other tests.
mock.module("server-only", () => ({}));
let repo: Record<string, unknown> | null = null;
const writes: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
mock.module("@octopus/db", () => ({ prisma: { repository: {
  findFirst: async () => repo,
  updateMany: async (write: { where: Record<string, unknown>; data: Record<string, unknown> }) => { writes.push(write); return { count: 1 }; },
} } }));
mock.module("@/lib/github", () => ({ getInstallationToken: async () => "token" }));
let incremental: () => Promise<unknown> = async () => ({ updatedFiles: 1, removedFiles: 0, newVectors: 1, incompleteFiles: [] });
let incrementalCalls = 0;
mock.module("@/lib/indexer", () => ({ incrementalIndex: async () => { incrementalCalls++; return incremental(); } }));
let pageStatuses: number[] = [200];
let pageSizes: number[] = [1];
let page = 0;
globalThis.fetch = (async () => {
  const status = pageStatuses[page] ?? 200;
  const size = pageSizes[page] ?? 0;
  page++;
  return Response.json(Array.from({ length: size }, (_, i) => ({ filename: `src/f${page}-${i}.ts`, status: "modified" })), { status });
}) as typeof fetch;
const { processIncrementalIndex } = await import("@/lib/incremental-index-job");

const job = { repositoryId: "repo-1", organizationId: "org-1", prNumber: 7, installationId: 1 };
const indexed = { id: "repo-1", fullName: "acme/app", defaultBranch: "main", indexStatus: "indexed", organizationId: "org-1", activeIndexGeneration: "gen-1" };
const reset = () => { writes.length = 0; incrementalCalls = 0; page = 0; pageStatuses = [200]; pageSizes = [1]; repo = indexed; };
const markedStale = () => writes.some(write => write.data.indexStatus === "stale");
const advancedIndexedAt = () => writes.some(write => write.data.indexedAt instanceof Date);
console.warn = () => {};

// A complete update advances indexedAt.
reset();
await processIncrementalIndex(job);
assert.equal(incrementalCalls, 1);
assert.ok(advancedIndexedAt());
assert.ok(!markedStale());

// A file whose fetch failed keeps its old chunks: the generation is marked stale with the guarded update and not stamped fresh.
reset();
incremental = async () => ({ updatedFiles: 2, removedFiles: 0, newVectors: 1, incompleteFiles: ["src/broken.ts"] });
await processIncrementalIndex(job);
assert.ok(markedStale());
assert.ok(!advancedIndexedAt(), "a partial update must not advance indexedAt");
assert.deepEqual(writes.find(write => write.data.indexStatus === "stale")!.where, { id: "repo-1", indexStatus: "indexed", activeIndexGeneration: "gen-1" });

// A later page of the PR's file list failing is not a complete list.
reset();
incremental = async () => ({ updatedFiles: 1, removedFiles: 0, newVectors: 1, incompleteFiles: [] });
pageStatuses = [200, 500]; pageSizes = [100, 0];
await processIncrementalIndex(job);
assert.equal(incrementalCalls, 0, "an incomplete file list is never indexed");
assert.ok(markedStale());
assert.ok(!advancedIndexedAt());

// A repository that is no longer indexed is left alone.
reset();
repo = { ...indexed, indexStatus: "indexing" };
await processIncrementalIndex(job);
assert.equal(incrementalCalls, 0);
assert.equal(writes.length, 0);
console.log("Incremental index job checks passed");
process.exit(0);
