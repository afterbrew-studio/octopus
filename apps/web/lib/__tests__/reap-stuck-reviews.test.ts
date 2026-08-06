import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

let orphans: Array<{ id: string; createdAt: Date }> = [];
let updateCount = 1;
const findMany = mock(async () => orphans);
const updateMany = mock(async () => ({ count: updateCount }));
mock.module("@octopus/db", () => ({
  prisma: { pullRequest: { findMany, updateMany } },
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
    enqueue.mockClear();
  });

  it("marks a recent orphan failed and re-queues exactly one throttled retry", async () => {
    orphans = [{ id: "pr_recent", createdAt: minutesAgo(30) }];
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

  it("fails an old backlog orphan without re-queuing (no comment spam)", async () => {
    orphans = [{ id: "pr_old", createdAt: daysAgo(40) }];
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 1 });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("skips a row a live worker already finished (update matched nothing)", async () => {
    orphans = [{ id: "pr_raced", createdAt: minutesAgo(30) }];
    updateCount = 0;
    const res = await reapStuckReviews(NOW);
    expect(res).toEqual({ requeued: 0, failed: 0 });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
