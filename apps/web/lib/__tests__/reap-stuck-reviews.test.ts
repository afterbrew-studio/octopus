import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

type Orphan = {
  id: string;
  createdAt: Date;
  attempts: Array<{ id: string; createdAt: Date }>;
};

let orphans: Orphan[] = [];
let updateCount = 1;
const findMany = mock(async () => orphans);
const updateMany = mock(async () => ({ count: updateCount }));
const attemptUpdateMany = mock(async () => ({ count: 1 }));
mock.module("@octopus/db", () => ({
  prisma: {
    pullRequest: { findMany, updateMany },
    reviewAttempt: { updateMany: attemptUpdateMany },
  },
}));

const enqueue = mock(async () => "job-id");
mock.module("@/lib/queue", () => ({
  enqueue,
  loadQueueConfig: async () => ({
    reviewTimeoutSeconds: 900,
    largeReviewTimeoutSeconds: 1800,
    reviewConcurrency: 2,
  }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));

const { reapStuckReviews, REAP_FAILED_MESSAGE } = await import(
  "@/lib/reap-stuck-reviews"
);

const NOW = new Date("2026-08-06T13:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60 * 1000);
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

describe("reapStuckReviews", () => {
  beforeEach(() => {
    orphans = [];
    updateCount = 1;
    findMany.mockClear();
    updateMany.mockClear();
    attemptUpdateMany.mockClear();
    enqueue.mockClear();
  });

  it("marks a recent orphan failed and re-queues exactly one throttled retry", async () => {
    orphans = [{ id: "pr_recent", createdAt: minutesAgo(30), attempts: [] }];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 1, failed: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "pr_recent", status: { in: ["reviewing", "queued"] } },
      data: { status: "failed", errorMessage: REAP_FAILED_MESSAGE },
    });
    expect(enqueue).toHaveBeenCalledWith(
      "process-review",
      { pullRequestId: "pr_recent" },
      { singletonKey: "reap:pr_recent", singletonSeconds: 3600 },
    );
  });

  it("carries the live attempt into the retry so it keeps its frozen config", async () => {
    orphans = [
      { id: "pr_attempt", createdAt: minutesAgo(30), attempts: [{ id: "att_1", createdAt: minutesAgo(30) }] },
    ];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith(
      "process-review",
      { pullRequestId: "pr_attempt", attemptId: "att_1" },
      { singletonKey: "reap:pr_attempt", singletonSeconds: 3600 },
    );
    // Still trying, so the attempt has not reached a terminal state.
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });

  it("only considers attempts that have not already finished", async () => {
    // The mocked client ignores the select clause, so the nested filter is
    // asserted on the query itself. Without it a reap would carry a terminal
    // attempt forward and re-run a decision that was already closed.
    orphans = [{ id: "pr_recent", createdAt: minutesAgo(30), attempts: [] }];
    await reapStuckReviews(NOW);
    const query = findMany.mock.calls[0]![0] as {
      select: { attempts: { where: unknown; orderBy: unknown; take: number } };
    };
    expect(query.select.attempts.where).toEqual({ terminalAt: null });
    expect(query.select.attempts.orderBy).toEqual({ createdAt: "desc" });
    expect(query.select.attempts.take).toBe(1);
  });

  it("fails an old backlog orphan without re-queuing (no comment spam)", async () => {
    orphans = [{ id: "pr_old", createdAt: daysAgo(40), attempts: [] }];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("terminates the attempt of an orphan that will never be retried", async () => {
    orphans = [
      { id: "pr_old", createdAt: daysAgo(40), attempts: [{ id: "att_dead", createdAt: daysAgo(40) }] },
    ];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    expect(attemptUpdateMany).toHaveBeenCalledWith({
      where: { id: "att_dead", terminalAt: null },
      data: {
        state: "failed",
        terminalAt: NOW,
        terminalDetail: REAP_FAILED_MESSAGE,
      },
    });
  });

  it("retries a fresh attempt on an old pull request", async () => {
    // The two ages diverge here, which is the whole point: a review dispatched
    // half an hour ago against a month-old pull request is fresh work. Comparing
    // the pull request's age would refuse it.
    orphans = [
      {
        id: "pr_old_attempt_new",
        createdAt: daysAgo(40),
        attempts: [{ id: "att_fresh", createdAt: minutesAgo(30) }],
      },
    ];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith(
      "process-review",
      { pullRequestId: "pr_old_attempt_new", attemptId: "att_fresh" },
      { singletonKey: "reap:pr_old_attempt_new", singletonSeconds: 3600 },
    );
  });

  it("skips a row a live worker already finished (update matched nothing)", async () => {
    orphans = [{ id: "pr_raced", createdAt: minutesAgo(30), attempts: [] }];
    updateCount = 0;
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(attemptUpdateMany).not.toHaveBeenCalled();
  });
});
