import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
const row = {
  id: "repo-1", provider: "github", organizationId: "org-1", fullName: "acme/new", defaultBranch: "main",
  installationId: 123, indexStatus: "pending", totalFiles: 0,
  organization: { githubInstallationId: 123 as number | null },
};
let currentRow: typeof row | null = row;
let claimCount = 1;
let indexFailure: Error | null = null;
let cancelled = false;
const queued: unknown[][] = [];
const indexCalls: unknown[][] = [];
const writes: Array<{ data: Record<string, unknown> }> = [];
const queries: Array<{ where: Record<string, unknown> }> = [];
const claims: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
let controller = new AbortController();
mock.module("@/lib/queue", () => ({
  enqueue: async (...args: unknown[]) => { queued.push(args); return "job-1"; },
}));
mock.module("@/lib/indexing-abort", () => ({
  createAbortController: () => { controller = new AbortController(); return controller; },
  clearAbortController: () => {},
}));
mock.module("@octopus/db", () => ({
  prisma: {
    repository: {
      findMany: async (args: { where: Record<string, unknown> }) => { queries.push(args); return [{ id: "repo-1" }]; },
      findFirst: async (args: { where: Record<string, unknown> }) => { queries.push(args); return currentRow; },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        claims.push(args); return { count: claimCount };
      },
      update: async (args: { data: Record<string, unknown> }) => { writes.push(args); return {}; },
    },
  },
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/elasticsearch", () => ({ writeSyncLog: () => {}, deleteSyncLogs: async () => {} }));
mock.module("@/lib/indexer", () => ({
  indexRepository: async (...args: unknown[]) => {
    indexCalls.push(args);
    if (cancelled) { controller.abort(); throw new Error("Indexing cancelled"); }
    if (indexFailure) throw indexFailure;
    return {
      indexedFiles: 0, totalFiles: 0, totalChunks: 0, totalVectors: 0,
      contributors: [], contributorCount: 0, durationMs: 12, resolvedDefaultBranch: "master",
    };
  },
}));
const { enqueuePendingRepositoryIndexes, processRepositoryIndex } = await import("@/lib/repository-index-job");
const job = { repositoryId: "repo-1", organizationId: "org-1" };

await assert.rejects(() => processRepositoryIndex({ repositoryId: "repo-1", organizationId: "" }), /requires/);
assert.equal(queries.length, 0, "invalid jobs must never issue an unscoped query");

await enqueuePendingRepositoryIndexes("org-1");
assert.deepEqual(queued, [["index-repository", job, { singletonKey: "repo-1", singletonSeconds: 60 }]]);
assert.deepEqual(queries[0].where, {
  organizationId: "org-1", provider: { in: ["github", "forgejo"] }, isActive: true, dismissedAt: null,
  organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true },
  OR: [{ indexStatus: { in: ["pending", "failed"] } }, { indexStatus: "indexed", totalFiles: 0 }],
});

await processRepositoryIndex(job);
assert.equal(indexCalls.length, 1);
assert.equal(indexCalls[0][3], 123, "the worker must use the org's bound installation");
assert.equal(writes[0].data.indexStatus, "indexed");
assert.equal(writes[0].data.defaultBranch, "master");
assert.equal(writes[0].data.totalFiles, 0, "an empty base must be a completed snapshot");
assert.equal(queries[1].where.organizationId, "org-1");
assert.equal(queries[1].where.dismissedAt, null);
assert.equal(queries[1].where.isActive, true);
assert.deepEqual(queries[1].where.organization, { deletedAt: null, bannedAt: null, autoDiscoverRepos: true });

claimCount = 0;
await processRepositoryIndex(job);
assert.equal(indexCalls.length, 1, "a competing review must keep its claim");
claimCount = 1;
currentRow = null;
await processRepositoryIndex(job);
assert.equal(indexCalls.length, 1, "removed or wrong-tenant rows must be skipped");
currentRow = { ...row, organization: { githubInstallationId: null } };
await processRepositoryIndex(job);
currentRow = { ...row, organization: { githubInstallationId: 456 } };
await processRepositoryIndex(job);
assert.equal(indexCalls.length, 1, "disconnected or mismatched installations must not index");

currentRow = row;
indexFailure = new Error("GitHub unavailable");
await assert.rejects(() => processRepositoryIndex(job), /GitHub unavailable/);
assert.equal(claims.at(-1)?.data.indexStatus, "failed", "failures must release the claim for retry");
indexFailure = null;
await processRepositoryIndex(job);
assert.equal(writes.length, 2, "a retry must be able to complete");

currentRow = { ...row, provider: "forgejo", organization: { githubInstallationId: null } };
await processRepositoryIndex(job);
assert.equal(indexCalls.at(-1)?.[3], 0);
assert.equal(indexCalls.at(-1)?.[6], "forgejo", "Forgejo jobs must not use GitHub authentication");

cancelled = true;
await processRepositoryIndex(job);
assert.equal(claims.at(-1)?.data.indexStatus, "pending", "cancelled work must release its claim");
const priorQueries = queries.length;
await enqueuePendingRepositoryIndexes("org-1", undefined, ["bitbucket", "gitlab", "unrecognized"]);
assert.equal(queries.length, priorQueries, "provider-scoped setup must not expand the indexing allowlist");
await enqueuePendingRepositoryIndexes("org-1", undefined, ["forgejo", "bitbucket"]);
assert.deepEqual(queries.at(-1)?.where.provider, { in: ["forgejo"] }, "a retry must not index a different provider");
console.log("Repository queue, tenant, claim, empty snapshot, failure, retry and cancellation checks passed");
