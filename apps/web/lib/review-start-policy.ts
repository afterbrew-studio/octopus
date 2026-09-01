/**
 * Which callers may start a review on this deployment.
 *
 * afterbrew runs Octopus as the routed reviewer for one autonomous lane, and rayf's
 * ADR-0056 makes Companion "the only review-dispatch authority". The thing that
 * decision guards against is a review starting on GITHUB's schedule rather than on
 * a deliberate one: every pull request opened, reopened or pushed to would spend
 * model budget nobody asked to spend, outside the attempt record that makes a paid
 * review attributable.
 *
 * That argument is about automation, not about the transport. A person adding a
 * review label, or writing `@octopus` on a pull request, is not GitHub's schedule;
 * it is a human asking for exactly one review, at a moment they chose. So `label`
 * and `mention` are permitted and the automatic `webhook` path stays refused. Each
 * is its own `ReviewSource` value, so the attempt record still says which one paid
 * for what -- which is the part of ADR-0056 that actually matters.
 *
 * `startReviewFlow` refuses the rest. That is the whole control, and it lives at
 * the one function every path goes through -- webhook call sites across GitHub,
 * Bitbucket and GitLab, plus the authenticated CLI route. Refusing at each caller
 * instead would be a check per site, and the next caller somebody adds would have
 * none.
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
  /** A provider webhook firing on the provider's own schedule. Never starts a review. */
  | "webhook"
  /** An authenticated request from the dispatching adapter. */
  | "adapter"
  /** A person adding a configured review label. Deliberate, and one review per request. */
  | "label"
  /** A person writing `@octopus` on a pull request. Same deliberate act, different gesture. */
  | "mention";

/**
 * The permitted sources, as an ALLOW-LIST.
 *
 * Deny-listing `webhook` would read the same today and fail differently later: a
 * source added next year would inherit permission because nobody remembered to
 * deny it. Membership means somebody decided.
 */
const MAY_START: ReadonlySet<ReviewSource> = new Set<ReviewSource>(["adapter", "label", "mention"]);

/** True when this deployment permits `source` to start a review. */
export function mayStartReview(source: ReviewSource): boolean {
  return MAY_START.has(source);
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
