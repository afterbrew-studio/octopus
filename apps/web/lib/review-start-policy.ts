/**
 * Only an authenticated adapter request may start a review on this deployment.
 *
 * afterbrew runs Octopus as the routed reviewer for one autonomous lane, and rayf's
 * ADR-0056 makes Companion "the only review-dispatch authority". A webhook that can
 * start a review is a second authority: it spends a model budget on GitHub's
 * schedule rather than on the lane's, outside the immutable attempt record that
 * makes every paid review attributable.
 *
 * So `startReviewFlow` refuses when the caller is a webhook. That is the whole
 * control, and it lives at the one function every path goes through -- six webhook
 * call sites across GitHub, Bitbucket and GitLab, plus the authenticated CLI route.
 * Refusing at each webhook instead would be six checks, and the seventh caller
 * somebody adds would have none.
 *
 * `ReviewSource` is a REQUIRED parameter rather than an optional one with a default.
 * A default is the failure this is guarding against: a new call site inherits the
 * permissive value and nobody notices. Required means the compiler rejects a caller
 * that has not said which it is.
 *
 * What deliberately still works: signature verification, installation state,
 * post-merge indexing, and everything else a webhook does that is not starting a
 * review. rayf P-0007 C2 asks for those events to be side-effect-free with respect
 * to reviews, not for the webhook to be switched off.
 */

export type ReviewSource =
  /** An inbound provider webhook. Never permitted to start a review here. */
  | "webhook"
  /** An authenticated request from the dispatching adapter. The only positive case. */
  | "adapter";

export class ReviewStartRefusedError extends Error {
  readonly source: ReviewSource;
  readonly statusCode = 403;

  constructor(source: ReviewSource, detail: string) {
    super(
      `a review may not be started from "${source}" on this deployment: ${detail}. ` +
        "This is a deployment policy, not a permission: it cannot be granted, " +
        "configured or enabled. See ADR-0056 and rayf P-0007 C2.",
    );
    this.name = "ReviewStartRefusedError";
    this.source = source;
  }
}

/** True when this deployment permits `source` to start a review. */
export function mayStartReview(source: ReviewSource): boolean {
  return source === "adapter";
}

/**
 * Throws unless the caller is the authenticated adapter. Called at the top of
 * `startReviewFlow`, before any upsert, placeholder comment, check run, dashboard
 * notification or enqueue -- so a refusal leaves no trace on the pull request,
 * which is what "side-effect-free" in C2 means.
 */
export function assertMayStartReview(source: ReviewSource, detail: string): void {
  if (!mayStartReview(source)) {
    throw new ReviewStartRefusedError(source, detail);
  }
}
