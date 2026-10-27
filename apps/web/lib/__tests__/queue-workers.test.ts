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

const { registerWorkers } = await import("@/lib/queue-workers");

type Handler = (jobs: unknown[]) => Promise<void>;

function fakeBoss() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    work: async (name: string, _opts: unknown, handler: Handler) => {
      handlers.set(name, handler);
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
