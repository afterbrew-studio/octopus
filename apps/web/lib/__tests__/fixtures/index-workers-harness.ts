import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: these module mocks must not reach other test files.
mock.module("server-only", () => ({}));
const indexCalls: unknown[][] = [];
const reaperCalls: string[] = [];
let releaseFailure = false;
const actualCompletion = await import("@/lib/repository-index-completion");
mock.module("@/lib/repository-index-completion", () => ({
  ...actualCompletion,
  releaseAbandonedIndexClaims: async () => { reaperCalls.push("index"); if (releaseFailure) throw new Error("db down"); return 2; },
}));
mock.module("@/lib/reap-stuck-reviews", () => ({
  reapStuckReviews: async () => { reaperCalls.push("reviews"); return { requeued: 0, failed: 0, unpublished: 0 }; },
}));
mock.module("@/lib/review-hold", () => ({ requeueOverdueHolds: async () => 0 }));
mock.module("@/lib/review-publication-reconcile", () => ({
  reconcileReviewPublication: async () => {}, requeueUnresolvedPublications: async () => {},
}));
mock.module("@/lib/reviewer", () => ({ processReview: async () => {} }));
const actualIndexJob = await import("@/lib/repository-index-job");
mock.module("@/lib/repository-index-job", () => ({
  ...actualIndexJob,
  processRepositoryIndex: async (...args: unknown[]) => { indexCalls.push(args); },
}));
const incrementalCalls: unknown[][] = [];
const actualIncremental = await import("@/lib/incremental-index-job");
mock.module("@/lib/incremental-index-job", () => ({
  ...actualIncremental,
  processIncrementalIndex: async (...args: unknown[]) => { incrementalCalls.push(args); },
}));
const { registerWorkers } = await import("@/lib/queue-workers");

type Handler = (jobs: unknown[]) => Promise<void>;
const handlers = new Map<string, Handler>();
const boss = {
  work: async (name: string, optionsOrHandler: unknown, handler?: Handler) => {
    handlers.set(name, typeof optionsOrHandler === "function" ? optionsOrHandler as Handler : handler!);
  },
};
await registerWorkers(boss as never, { reviewConcurrency: 1 } as Parameters<typeof registerWorkers>[1]);

// The index worker hands pg-boss's abort signal and the job's own expiry to the run.
const signal = new AbortController().signal;
await handlers.get("index-repository")!([{ id: "job1", data: { repositoryId: "r", organizationId: "o" }, expireInSeconds: 1800, signal }]);
assert.deepEqual(indexCalls, [[{ repositoryId: "r", organizationId: "o" }, { signal, expireInSeconds: 1800 }]]);

// Merged-PR updates are worked from the singleton queue with the job's own signal and expiry.
const incrementalJob = { repositoryId: "r", organizationId: "o", prNumber: 7, installationId: 1 };
await handlers.get("incremental-index")!([{ id: "job4", data: incrementalJob, expireInSeconds: 1800, signal }]);
assert.deepEqual(incrementalCalls, [[incrementalJob, { signal, expireInSeconds: 1800 }]]);

// The reaper also releases abandoned index claims, and a failure there does not stop the review reaper.
const reap = handlers.get("reap-stuck-reviews")!;
await reap([{ id: "job2" }]);
assert.deepEqual(reaperCalls, ["index", "reviews"]);
reaperCalls.length = 0;
releaseFailure = true;
console.error = () => {};
await reap([{ id: "job3" }]);
assert.deepEqual(reaperCalls, ["index", "reviews"]);
console.log("Index worker wiring checks passed");
process.exit(0);
