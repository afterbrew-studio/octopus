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

// How long a `pending` pull request may sit before its attempt is assumed to
// have lost its enqueue. Must exceed the time between an attempt being written
// and a worker claiming the job, which is queue latency rather than review time.
const PENDING_ENQUEUE_GRACE_MS =
  (Number(process.env.OCTOPUS_PENDING_ENQUEUE_GRACE_MINUTES) || 10) * 60 * 1000;

export const REAP_FAILED_MESSAGE =
  "Review interrupted by a server restart or timeout. Push a new commit or comment @octopus to retry.";

export async function reapStuckReviews(
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number; unpublished: number }> {
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
  // Shorter than the two above: a pending row is waiting to be PICKED UP, not
  // waiting for a review to run, so the window only has to exceed normal queue
  // latency. Long enough that a worker about to claim it is not raced.
  const pendingStale = new Date(now.getTime() - PENDING_ENQUEUE_GRACE_MS);

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
        select: { id: true, createdAt: true },
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
    const attempt = pr.attempts[0];
    const attemptId = attempt?.id;

    // The age that decides a retry is the ATTEMPT's, not the pull request's. They
    // diverge exactly where it matters: a review dispatched an hour ago against a
    // pull request opened last month is fresh work, and comparing the pull request's
    // age would refuse to retry it. The pull request's date is the fallback for
    // reviews that predate attempts.
    const startedAt = attempt?.createdAt ?? pr.createdAt;

    if (startedAt > requeueCutoff) {
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

  // --- attempts that were committed and never enqueued ---------------------
  //
  // `startReviewFlow` writes the attempt and THEN enqueues. The two are in
  // different systems with no transaction between them, so a process killed
  // between the lines leaves a durable record of intent and no job to act on it.
  // The pull request sits in `pending` forever: the scan above never looks at
  // `pending`, and the caller's retry hits the same-SHA early return and reports
  // success.
  //
  // The attempt row IS the outbox record here - it is committed first precisely
  // so the durable half precedes the volatile one - so reconciliation is a matter
  // of noticing one that never got its job.
  //
  // A pending row with NO attempt is left alone. Those predate attempts, and
  // re-enqueuing one would address it by pull request id, which is the thing the
  // attempt exists to stop.
  const unenqueued = await prisma.pullRequest.findMany({
    where: {
      status: "pending",
      updatedAt: { lt: pendingStale },
      attempts: { some: { terminalAt: null } },
    },
    select: {
      id: true,
      attempts: {
        where: { terminalAt: null },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, createdAt: true },
      },
    },
  });

  let unpublished = 0;
  for (const pr of unenqueued) {
    const attempt = pr.attempts[0];
    if (!attempt || attempt.createdAt >= pendingStale) continue;
    await enqueue(
      "process-review",
      { pullRequestId: pr.id, attemptId: attempt.id },
      // Same throttle as the reap path, and a distinct key: a pull request can be
      // both reaped and reconciled over its life, and one singleton would let the
      // first suppress the second for an hour.
      { singletonKey: `reconcile:${pr.id}`, singletonSeconds: 3600 },
    );
    unpublished++;
  }

  return { requeued, failed, unpublished };
}
