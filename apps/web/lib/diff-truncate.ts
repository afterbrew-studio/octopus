// Shared diff-size cap for the review engine, used by every provider path
// (GitHub, GitLab, Bitbucket) so the limit can't drift between them.
//
// Sized to fit the model context (~200k-token windows ≈ ~800k chars) alongside
// the reviewer's RAG context, rulepacks and output, with headroom — 300k chars
// (~7.5k diff lines) covers the overwhelming majority of PRs so they review IN
// FULL. Env-tunable (MAX_DIFF_CHARS) to trade coverage vs. token cost without a
// redeploy. The old 30k default silently truncated everyday PRs, so
// security-critical files past the cut went unreviewed while a confident score
// was still posted (#1429).

export const MAX_DIFF_CHARS = (() => {
  const n = Number(process.env.MAX_DIFF_CHARS);
  return Number.isFinite(n) && n > 0 ? n : 300_000;
})();

// Stable substring identifying a truncation notice (also used to build it).
export const TRUNCATION_MARKER = "[... diff truncated";

/** The factual truncation notice appended to a cut diff (no "split your PR" nag). */
export function truncationNotice(): string {
  return `\n\n${TRUNCATION_MARKER} at ${MAX_DIFF_CHARS.toLocaleString("en-US")} chars — remaining files not included]`;
}

/** Cut a diff to the cap with a truncation notice; leaves ≤cap diffs unchanged. */
export function truncateDiff(diff: string): string {
  return diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + truncationNotice() : diff;
}
