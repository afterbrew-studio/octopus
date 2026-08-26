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
 * The refusal is a BOOLEAN, and the caller returns. It was an exception first, and
 * that was wrong: no webhook route catches, so the throw became a 500, the provider
 * read a failed delivery and retried it. A policy meaning "this event starts no
 * review" would have meant "this event fails loudly, on a retry schedule". The
 * delivery genuinely succeeded; it simply started nothing.
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

/** True when this deployment permits `source` to start a review. */
export function mayStartReview(source: ReviewSource): boolean {
  return source === "adapter";
}

/**
 * What gets logged when a start is refused.
 *
 * Worded so nobody mistakes it for a permissions problem they could go and fix:
 * somebody reading "forbidden" goes looking for the role that grants it, finds
 * none, and has spent the search for nothing. `detail` names the pull request, so
 * a refusal is distinguishable in a log from a no-op.
 */
export function reviewRefusalMessage(source: ReviewSource, detail: string): string {
  return (
    `a review may not be started from "${source}" on this deployment: ${detail}. ` +
    "This is a deployment policy, not a permission: it cannot be granted, " +
    "configured or enabled. See ADR-0056 and rayf P-0007 C2."
  );
}
