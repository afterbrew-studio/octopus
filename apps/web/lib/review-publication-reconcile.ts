import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { dismissPullRequestReview, listPullRequestReviewsStrict } from "@/lib/github";
import { getGithubAppConfig } from "@/lib/github-app-config";
import { enqueueAfter } from "@/lib/queue";
import { RECONCILE_QUEUE, type PublicationRecord } from "@/lib/review-verdict";

/** Clock skew between this server and the provider, when matching a review to its send. */
const SKEW_MS = 60_000;
/** Passes that may find nothing before the verdict is recorded as never having appeared. */
const MAX_EMPTY_CHECKS = 2;
const RECHECK_DELAY_SECONDS = 300;

const STATE_FOR_EVENT = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED" } as const;

async function settle(record: PublicationRecord, state: PublicationRecord["state"], checks = record.checks): Promise<void> {
  if (!record.runId) return;
  await prisma.reviewRun.updateMany({
    where: { id: record.runId },
    data: { publication: { ...record, state, checks } as unknown as Prisma.InputJsonValue },
  });
}

/**
 * Settles one unresolved verdict. Throws on any provider or database failure, so
 * the job is retried and the record stays pending; nothing is marked done that
 * was not.
 *
 * A review matches only if this app authored it, for the commit and event that
 * were sent, at or after the send, and it is still active (a dismissed review has
 * a DISMISSED state and never matches). Nothing in a review's text is trusted: a
 * pull request's author controls that, and cannot control who a review is by.
 */
export async function reconcileReviewPublication(payload: PublicationRecord): Promise<void> {
  let record = payload;
  if (record.runId) {
    const run = await prisma.reviewRun.findUnique({ where: { id: record.runId }, select: { publication: true } });
    const stored = run?.publication as PublicationRecord | null | undefined;
    if (stored && stored.state !== "pending") return;
    if (stored) record = stored;
  }

  const appLogin = `${(await getGithubAppConfig())?.slug ?? "octopus-review"}[bot]`;
  const sentAt = Date.parse(record.sentAt);
  const reviews = await listPullRequestReviewsStrict(record.installationId, record.owner, record.repo, record.prNumber);
  const standing = reviews.filter((review) =>
    review.user === appLogin
    && review.commitId === record.commitId
    && review.state === STATE_FOR_EVENT[record.event]
    && review.submittedAt !== null && Date.parse(review.submittedAt) >= sentAt - SKEW_MS);

  if (standing.length === 0) {
    // Not found is not proof of absence while the provider may still be settling.
    if (record.checks + 1 < MAX_EMPTY_CHECKS) {
      await settle(record, "pending", record.checks + 1);
      const jobId = await enqueueAfter(RECONCILE_QUEUE, { ...record, checks: record.checks + 1 }, RECHECK_DELAY_SECONDS);
      if (!jobId) throw new Error("Could not schedule the next publication check");
      return;
    }
    await settle(record, "absent", record.checks + 1);
    return;
  }

  const current = await prisma.pullRequest.findUnique({ where: { id: record.pullRequestId }, select: { headSha: true, reviewRequestVersion: true } });
  const replaced = !current || current.headSha !== record.headSha || current.reviewRequestVersion !== record.reviewRequestVersion;
  if (!replaced) {
    await settle(record, "current");
    return;
  }

  for (const review of standing) {
    await dismissPullRequestReview(record.installationId, record.owner, record.repo, record.prNumber, review.id,
      "Superseded by a newer review request for this pull request.");
  }
  await settle(record, "dismissed");
}

/** How long a record may sit pending before its job is presumed lost. */
const UNRESOLVED_GRACE_MS = 15 * 60_000;

/**
 * The record on a run is the durable half; the delayed job is the volatile half. A
 * record still pending well past its delay lost its job (or exhausted its retries),
 * so it is scheduled again. The singleton key keeps repeated sweeps from stacking.
 */
export async function requeueUnresolvedPublications(now: Date = new Date()): Promise<number> {
  const runs = await prisma.reviewRun.findMany({
    where: { publication: { path: ["state"], equals: "pending" } },
    select: { id: true, publication: true },
  });
  let requeued = 0;
  for (const run of runs) {
    const record = run.publication as PublicationRecord | null;
    if (!record || now.getTime() - Date.parse(record.sentAt) < UNRESOLVED_GRACE_MS) continue;
    await enqueueAfter(RECONCILE_QUEUE, record, 0, { singletonKey: `publication:${run.id}`, singletonSeconds: 900 });
    requeued++;
  }
  return requeued;
}
