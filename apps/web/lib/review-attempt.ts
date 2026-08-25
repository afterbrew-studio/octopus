import type { ReviewConfig } from "@/lib/review-helpers";

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

/** The frozen part of an attempt this decision needs. */
export interface AttemptSnapshot {
  readonly configSnapshot: unknown;
}

/**
 * The snapshot wins whenever there is one.
 *
 * `live` is still evaluated by the caller and passed in, deliberately: it is the
 * fallback for jobs enqueued before attempts existed, which are still in the
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
