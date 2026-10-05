import "server-only";
import type { ReviewConfig } from "@/lib/review-helpers";
import { isReviewRequestVersion } from "@/lib/review-status-state";
import { isDeepStrictEqual } from "node:util";
import { prisma, type Prisma } from "@octopus/db";
import { withForgejoPublication } from "@/lib/forgejo-connector";
import type { ReviewCoverage } from "@/lib/review-coverage";

/**
 * Which configuration a review actually runs with.
 *
 * `processReview` merges system, organization and repository config at execution
 * time. All three are mutable, so that merge answers "what is configured now",
 * not "what was approved when this was enqueued". Change a model between the
 * enqueue and the worker picking the job up and the review silently runs with the
 * new one -- what executed is not what was approved, and the record of it is
 * unreliable in exactly the case anyone would want to audit.
 *
 * rayf P-0007 C3: "configuration changes between enqueue and execution do not
 * change the attempt."
 *
 * A named function rather than a ternary at the call site so the rule can be
 * tested directly. An inline conditional inside a 2,700-line function is a rule
 * nobody can assert against.
 */

/** The frozen part of a `ReviewRun` this decision needs. */
export interface AttemptSnapshot {
  readonly configSnapshot: unknown;
}

/**
 * The snapshot wins whenever there is one.
 *
 * `live` is still evaluated by the caller and passed in, deliberately: it is the
 * fallback for jobs enqueued before runs existed, which are still in the
 * queue and were enqueued under the old behaviour. Refusing them would strand
 * real work.
 */
export function resolveReviewConfig(
  attempt: AttemptSnapshot | null | undefined,
  live: ReviewConfig,
): ReviewConfig {
  if (!attempt) return live;
  const snapshot = attempt.configSnapshot;
  // A snapshot that is not an object is not a snapshot. Falling back is wrong
  // here -- it would silently restore the behaviour this exists to remove -- so
  // an empty config is used instead, which fails visibly rather than quietly
  // running with whatever is configured now.
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    return {} as ReviewConfig;
  }
  return snapshot as ReviewConfig;
}

/**
 * What terminal state a `ReviewRun` reached, derived from the pull request's
 * status once execution returns.
 *
 * Derived rather than threaded. `processReview` is one 2,100-line function with
 * around a dozen exits -- completion, failure, delegation to the large-review
 * pipeline, "reviews are paused", "already completed", a deferral --
 * and marking the run at each of them means every future exit somebody adds
 * silently leaves the run `pending`. The pull request's status is already
 * written at each of those exits, so reading it afterwards answers the same
 * question without depending on anyone remembering.
 *
 * `null` means the run is NOT terminal: work is still in flight. `queued` is
 * that case -- the large-review handoff parks a pull request there with the
 * internal-cli job due to pick it up, and terminalising the run would claim a
 * review ended when it had only moved. Deferrals park at `pending` instead and
 * are kept alive by `processReview` skipping finalization on a "deferred" outcome.
 */
export function attemptOutcomeForStatus(
  status: string | null | undefined,
): { state: "succeeded" | "failed" | "cancelled"; detail: string } | null {
  switch (status) {
    case "completed":
      return { state: "succeeded", detail: "review completed" };
    case "failed":
      return { state: "failed", detail: "review failed" };
    case "queued":
      return null;
    default:
      // `reviewing` or `pending` after execution returned means an early exit that
      // wrote no terminal status: reviews paused for the organization, an author on
      // the blocked list, a duplicate claim. None of those ran the review, and none
      // of them is a failure of it, so the run is cancelled rather than failed --
      // and, either way, it does not stay `pending` forever pretending to be live.
      return {
        state: "cancelled",
        detail: `review did not run (pull request left "${status ?? "unknown"}")`,
      };
  }
}

/** `claimToken` binds the write to one worker's claim, so a worker that lost the row writes nothing. */
export async function updateCurrentReview(pullRequestId: string, headSha: string | null, reviewRequestVersion: number | undefined, data: Prisma.PullRequestUpdateManyMutationInput, expectedReviewBody?: string, claimToken?: string) {
  if (!headSha || !isReviewRequestVersion(reviewRequestVersion)) return { count: 0 };
  return prisma.pullRequest.updateMany({ where: { id: pullRequestId, headSha, reviewRequestVersion, ...(expectedReviewBody !== undefined ? { reviewBody: expectedReviewBody } : {}), ...(claimToken !== undefined ? { claimToken } : {}) }, data });
}

/** Call only after the final report has been published successfully. Never infer this from an archived result. */
export async function recordFirstReviewCompletion(pullRequestId: string, headSha: string | null, reviewRequestVersion: number | undefined, reviewBody: string) {
  if (!headSha || !isReviewRequestVersion(reviewRequestVersion)) return;
  await prisma.pullRequest.updateMany({
    where: { id: pullRequestId, headSha, reviewRequestVersion, reviewBody, status: "completed", firstReviewCompletedAt: null },
    data: { firstReviewCompletedAt: new Date() },
  });
}

export async function createReviewAttemptComment(
  pullRequestId: string,
  headSha: string | null,
  reviewRequestVersion: number | undefined,
  create: () => Promise<number>,
  expectedReviewBody?: string,
): Promise<number> {
  let saved = false;
  return withForgejoPublication(async () => {
    const id = await create();
    const updated = await updateCurrentReview(pullRequestId, headSha, reviewRequestVersion, { reviewCommentId: id }, expectedReviewBody);
    saved = updated.count === 1;
    return id;
  }, { key: JSON.stringify([pullRequestId, headSha, reviewRequestVersion]), acknowledged: async () => saved });
}

export function withForgejoReviewPublication<T>(
  pullRequestId: string, headSha: string | null, reviewRequestVersion: number,
  review: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
  return withForgejoPublication(review, {
    key: JSON.stringify([pullRequestId, headSha, reviewRequestVersion]), signal,
    acknowledged: async tx => (await tx.pullRequest.count({ where: {
      id: pullRequestId, headSha, reviewRequestVersion, status: { in: ["completed", "failed"] },
    } })) === 1,
  });
}

export async function hasReviewAttempt(attemptId: string, pullRequestId: string, coverage: ReviewCoverage, reviewBody: string, client: Pick<Prisma.TransactionClient, "reviewAttempt"> = prisma) {
  const existing = await client.reviewAttempt.findUnique({ where: { id: attemptId } });
  if (!existing) return false;
  if (existing.pullRequestId !== pullRequestId || existing.headSha !== coverage.headSha || existing.baseSha !== coverage.baseSha
    || existing.reviewBody !== reviewBody || !isDeepStrictEqual(existing.coverage, JSON.parse(JSON.stringify(coverage)))) {
    throw new Error("Review attempt identity conflict");
  }
  return true;
}

/** Store a new immutable result and the current PR view atomically. */
export async function saveReviewAttempt(
  attemptId: string,
  pullRequestId: string,
  coverage: ReviewCoverage,
  reviewBody: string,
  issues?: Prisma.ReviewIssueCreateManyInput[],
  /** When given, the archive is still written but the current view is only replaced while this claim holds. */
  claimToken?: string,
) {
  const coverageJson = JSON.parse(JSON.stringify(coverage)) as Prisma.InputJsonValue;
  return prisma.$transaction(async tx => {
    const inserted = await tx.reviewAttempt.createMany({ skipDuplicates: true, data: [{
      id: attemptId, pullRequestId, headSha: coverage.headSha,
      baseSha: coverage.baseSha, coverage: coverageJson, reviewBody,
    }] });
    if (!inserted.count) {
      if (!await hasReviewAttempt(attemptId, pullRequestId, coverage, reviewBody, tx)) throw new Error("Review attempt identity conflict");
      return false;
    }
    if (!coverage.headSha || !isReviewRequestVersion(coverage.reviewRequestVersion)) return false;
    const promoted = await tx.pullRequest.updateMany({ where: { id: pullRequestId, headSha: coverage.headSha, reviewRequestVersion: coverage.reviewRequestVersion, ...(claimToken !== undefined ? { claimToken } : {}) }, data: {
      status: "completed", reviewBody, reviewCoverage: coverageJson, errorMessage: null,
    } });
    if (!promoted.count) return false;
    if (issues !== undefined) {
      await tx.reviewIssue.deleteMany({ where: { pullRequestId } });
      if (issues.length) await tx.reviewIssue.createMany({ data: issues });
    }
    return true;
  });
}
