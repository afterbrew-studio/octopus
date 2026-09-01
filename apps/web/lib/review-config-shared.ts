/**
 * Pure parsing for the per-repository review config. No `server-only`, deliberately:
 * `review-config.ts` fetches and cannot be imported from a test, and the same split
 * already exists for `repo-config-shared.ts` and `repo-config.ts`.
 */

/**
 * Per-repository review behaviour, committed to the repository being reviewed.
 *
 * This is the same shape the other hosted reviewers use: a JSON file at the repository
 * root, named after the vendor, whose `labels` array names the labels that ask for a
 * review. Maintainers already expect to configure a reviewer that way, and putting the
 * trigger where the repository can see it means a fork or a clone carries its own answer
 * rather than inheriting one from a dashboard.
 *
 * Distinct from `.github/octopus.yml`, which is the OSS bot-account consent marker: its
 * PRESENCE is the signal and its contents are never read. Two different questions, and
 * conflating them would make committing a review preference an opt-in to public bot
 * reviews.
 */
export const REVIEW_CONFIG_PATH = "octopus.json";

/** How many labels one repository may configure. A bound, not a judgement. */
export const MAX_REVIEW_LABELS = 20;

export type ReviewConfig = {
  /** Labels whose addition to a pull request asks for a review. */
  labels: string[];
};

/**
 * Parse the config file's contents.
 *
 * Total: any shape that is not a JSON object with a `labels` array of strings yields no
 * labels rather than throwing. A malformed config must not take the webhook down, and it
 * must not silently review everything either -- so the failure direction is "no trigger",
 * which is what the repository had before the file existed.
 */
export function parseReviewConfig(raw: string | null): ReviewConfig {
  if (!raw) return { labels: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { labels: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { labels: [] };
  }
  const value = (parsed as Record<string, unknown>).labels;
  if (!Array.isArray(value)) return { labels: [] };
  const labels: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    // A label is compared verbatim against what GitHub sends, so an empty or
    // whitespace-only entry could never match and is dropped rather than kept.
    if (!trimmed || labels.includes(trimmed)) continue;
    labels.push(trimmed);
    if (labels.length >= MAX_REVIEW_LABELS) break;
  }
  return { labels };
}

/**
 * Whether the label just added to a pull request asks for a review.
 *
 * Exact match against the configured list. A substring test would let `not-review:octopus`
 * -- which reads as its own negation -- spend a metered review.
 */
export function labelAsksForReview(config: ReviewConfig, label: string): boolean {
  return config.labels.includes(label.trim());
}
