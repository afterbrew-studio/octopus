/** The review timeout plus five minutes can never be less than this: the shortest window any reclaim path uses. */
export const SHORTEST_STALE_WINDOW_MS = 300_000;

/**
 * Longest a single provider call in the publication phase may run.
 *
 * Each call is preceded by a conditional reservation that refreshes the row's
 * `updatedAt`, and every reclaim path needs it to be older than the stale window.
 * So a call that finishes well inside that window needs no renewal while it runs:
 * the bound is a quarter of the window, never more than the configured value.
 */
export function publicationCallTimeoutMs(staleWindowMs: number): number {
  const configured = Number(process.env.OCTOPUS_PUBLICATION_CALL_TIMEOUT_MS);
  const wanted = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
  return Math.max(1, Math.min(wanted, Math.floor(staleWindowMs / 4)));
}

/**
 * A write whose outcome is unknown: the request may or may not have been applied.
 * Distinct from a rejection, which is definitive. It is never repeated in the same
 * breath: a later reconcile decides what happened.
 */
export class AmbiguousPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPublicationError";
  }
}
