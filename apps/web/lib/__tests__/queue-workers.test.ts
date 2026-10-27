import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * `process-review` jobs are durable across a deploy (pg-boss persists them in
 * the DB): a job enqueued under the pre-rename field name `attemptId` can
 * still be sitting in the queue when the renamed worker starts reading
 * `reviewRunId`. The worker must fall back to the old field rather than
 * silently dropping that job's frozen run.
 */

const processReviewCalls: unknown[][] = [];
mock.module("@/lib/reviewer", () => ({
  processReview: async (...args: unknown[]) => { processReviewCalls.push(args); },
}));

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
const actualIndexJob = await import("@/lib/repository-index-job");
mock.module("@/lib/repository-index-job", () => ({
  ...actualIndexJob,
  processRepositoryIndex: async (...args: unknown[]) => { indexCalls.push(args); },
}));

const { registerWorkers } = await import("@/lib/queue-workers");

type Handler = (jobs: unknown[]) => Promise<void>;

function fakeBoss() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    work: async (name: string, optionsOrHandler: unknown, handler?: Handler) => {
      handlers.set(name, typeof optionsOrHandler === "function" ? optionsOrHandler as Handler : handler!);
    },
  };
}

const config = { reviewConcurrency: 1 } as Parameters<typeof registerWorkers>[1];

describe("process-review worker", () => {
  it("reads the new reviewRunId field when present", async () => {
    processReviewCalls.length = 0;
    const boss = fakeBoss();
    await registerWorkers(boss as never, config);
    const handler = boss.handlers.get("process-review")!;
    await handler([{
      id: "job1", data: { pullRequestId: "pr1", reviewRunId: "run1" },
      startedOn: new Date(), expireInSeconds: 900, signal: new AbortController().signal,
    }]);
    expect(processReviewCalls).toHaveLength(1);
    expect(processReviewCalls[0]![0]).toBe("pr1");
    expect(processReviewCalls[0]![2]).toBe("run1");
  });

  it("falls back to the pre-rename attemptId field for a job already in the queue", async () => {
    processReviewCalls.length = 0;
    const boss = fakeBoss();
    await registerWorkers(boss as never, config);
    const handler = boss.handlers.get("process-review")!;
    await handler([{
      id: "job2", data: { pullRequestId: "pr2", attemptId: "legacy-run" },
      startedOn: new Date(), expireInSeconds: 900, signal: new AbortController().signal,
    }]);
    expect(processReviewCalls).toHaveLength(1);
    expect(processReviewCalls[0]![0]).toBe("pr2");
    expect(processReviewCalls[0]![2]).toBe("legacy-run");
  });
});

describe("index-repository worker", () => {
  it("hands the queue's abort signal and the job's own expiry to the run", async () => {
    indexCalls.length = 0;
    const boss = fakeBoss();
    await registerWorkers(boss as never, config);
    const signal = new AbortController().signal;
    await boss.handlers.get("index-repository")!([{ id: "job3", data: { repositoryId: "r", organizationId: "o" }, expireInSeconds: 1800, signal }]);
    expect(indexCalls).toEqual([[{ repositoryId: "r", organizationId: "o" }, { signal, expireInSeconds: 1800 }]]);
  });
});

describe("reap-stuck-reviews worker", () => {
  it("also releases abandoned index claims, and a failure there does not stop the review reaper", async () => {
    const boss = fakeBoss();
    await registerWorkers(boss as never, config);
    const handler = boss.handlers.get("reap-stuck-reviews")!;
    reaperCalls.length = 0;
    await handler([{ id: "job4" }]);
    expect(reaperCalls).toEqual(["index", "reviews"]);
    reaperCalls.length = 0;
    releaseFailure = true;
    const errors = console.error;
    console.error = () => {};
    try { await handler([{ id: "job5" }]); } finally { console.error = errors; releaseFailure = false; }
    expect(reaperCalls).toEqual(["index", "reviews"]);
  });
});
