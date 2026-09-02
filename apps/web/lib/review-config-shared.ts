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

/** How many label-to-model entries one repository may configure. Same reasoning. */
export const MAX_REVIEW_MODELS = 20;

export type ReviewConfig = {
  /** Labels whose addition to a pull request asks for a review. */
  labels: string[];
  /**
   * Label to model id. A pull request carrying one of these labels is reviewed by that
   * model instead of the repository's usual one.
   *
   * This exists because a repository's own sense of how much a change deserves is better
   * than any heuristic read of its diff. `classifyDiff` can see that a change is large or
   * touches shared files; it cannot know that a twenty-line migration is the riskiest thing
   * shipped this month. A maintainer labelling it can.
   *
   * Read from the default branch, never the pull request's head, for the same reason the
   * trigger labels are: otherwise a pull request could select its own reviewer.
   */
  models: Record<string, string>;
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
  if (!raw) return { labels: [], models: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { labels: [], models: {} };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { labels: [], models: {} };
  }
  const value = (parsed as Record<string, unknown>).labels;
  if (!Array.isArray(value)) return { labels: [], models: parseModels(parsed) };
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
  return { labels, models: parseModels(parsed) };
}

/**
 * Read the `models` map, total in the same way `labels` is.
 *
 * A malformed entry is dropped rather than throwing, so a typo in one mapping cannot cost
 * the repository its review. The failure direction is "no override", which leaves the
 * repository on whatever model it would have used before the key existed.
 *
 * The model id is NOT validated here. `resolveReviewModel` already refuses a model with no
 * pricing and falls back, so validating a second time in a parser that cannot see the
 * pricing table would either duplicate that list or reject a model the deployment has.
 */
function parseModels(parsed: unknown): Record<string, string> {
  const raw = (parsed as Record<string, unknown>).models;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const models: Record<string, string> = {};
  for (const [label, model] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof model !== "string") continue;
    const key = label.trim();
    const value = model.trim();
    // An empty label could never match what GitHub sends, and an empty model would
    // resolve to nothing; both are dropped rather than stored as a mapping that cannot fire.
    if (!key || !value || key in models) continue;
    models[key] = value;
    if (Object.keys(models).length >= MAX_REVIEW_MODELS) break;
  }
  return models;
}

/**
 * The model a pull request's labels ask for, or null.
 *
 * First match by the config's own key order, so a repository listing the strongest tier
 * first gets it when a pull request carries two. Deterministic either way, which matters
 * because the alternative is a review whose cost depends on GitHub's label ordering.
 */
export function modelForLabels(config: ReviewConfig, labels: readonly string[]): string | null {
  const present = new Set(labels.map((l) => l.trim()));
  for (const [label, model] of Object.entries(config.models)) {
    if (present.has(label)) return model;
  }
  return null;
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
