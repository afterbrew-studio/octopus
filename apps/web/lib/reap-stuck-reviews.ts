import { prisma } from "@octopus/db";
import { enqueue, loadQueueConfig, computeStaleReclaimMs } from "./queue";

// Reviews that die mid-flight (engine restart on deploy, crash, OOM, or a hang
// past the job timeout) are left in "reviewing"/"queued" forever: the finalize
// path never runs, so no error is written, and pg-boss's own retries hit the
// claim guard inside the stale-reclaim window and get skipped. Without this
// reaper they accumulate as permanent silent orphans (observed: 37 days' worth).
//
// The reaper marks every orphan `failed` with a real message — `failed` is
// re-claimable, so a future push / @octopus re-review works cleanly — and, for
// PRs young enough that a re-review is still wanted, enqueues one auto-retry.
// The singletonKey throttles that to at most one reaper-requeue per PR per hour,
// so a genuinely poison PR can't be re-reviewed in a tight loop.

const REQUEUE_MAX_AGE_MS =
  (Number(process.env.OCTOPUS_REAP_REQUEUE_MAX_AGE_HOURS) || 6) * 60 * 60 * 1000;

export const REAP_FAILED_MESSAGE =
  "Review interrupted by a server restart or timeout. Push a new commit or comment @octopus to retry.";

export async function reapStuckReviews(
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number }> {
  const config = await loadQueueConfig();
  // Same two windows as the claim guard (reviewer.ts): "reviewing" uses the
  // in-process timeout, "queued" the longer internal-cli timeout. Both exceed
  // the pg-boss job timeout, so a row past the window is genuinely dead — a live
  // worker would have been killed by pg-boss before its updatedAt got this old.
  const reviewingStale = new Date(
    now.getTime() - computeStaleReclaimMs(config.reviewTimeoutSeconds),
  );
  const queuedStale = new Date(
    now.getTime() - computeStaleReclaimMs(config.largeReviewTimeoutSeconds),
  );

  const orphans = await prisma.pullRequest.findMany({
    where: {
      OR: [
        { status: "reviewing", updatedAt: { lt: reviewingStale } },
        { status: "queued", updatedAt: { lt: queuedStale } },
      ],
    },
    select: {
      id: true,
      createdAt: true,
      // The frozen decision the dead review was carrying. A reaped review is a
      // retry of the same approved attempt, so the retry has to carry the same
      // snapshot: addressing the requeue by pull request id alone drops it and
      // the retry silently re-merges whatever is configured now.
      attempts: {
        where: { terminalAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true },
      },
    },
  });

  const requeueCutoff = new Date(now.getTime() - REQUEUE_MAX_AGE_MS);
  let requeued = 0;
  let failed = 0;

  for (const pr of orphans) {
    // Guard on status so we never clobber a review a live worker just finished.
    const updated = await prisma.pullRequest.updateMany({
      where: { id: pr.id, status: { in: ["reviewing", "queued"] } },
      data: { status: "failed", errorMessage: REAP_FAILED_MESSAGE },
    });
    if (updated.count === 0) continue;

    // Absent for reviews enqueued before attempts existed. Those keep the old
    // behaviour rather than being refused, which would strand real work.
    const attemptId = pr.attempts[0]?.id;

    if (pr.createdAt > requeueCutoff) {
      await enqueue(
        "process-review",
        attemptId ? { pullRequestId: pr.id, attemptId } : { pullRequestId: pr.id },
        { singletonKey: `reap:${pr.id}`, singletonSeconds: 3600 },
      );
      requeued++;
    } else {
      // No retry is coming, so the attempt is over. This is the only place that
      // knows: the worker that would have finalised it is gone. The terminalAt
      // guard keeps the "written once" property under a race with a late worker.
      if (attemptId) {
        await prisma.reviewAttempt.updateMany({
          where: { id: attemptId, terminalAt: null },
          data: {
            state: "failed",
            terminalAt: now,
            terminalDetail: REAP_FAILED_MESSAGE,
          },
        });
      }
      failed++;
    }
  }

  return { requeued, failed };
}
