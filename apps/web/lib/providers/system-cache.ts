/**
 * Prompt-cache breakpoint support (#650). The review system prompt carries a
 * marker splitting the stable, cacheable instruction/rulepack prefix from the
 * per-review volatile context. The Anthropic provider turns the marker into a
 * `cache_control` breakpoint so the prefix is reused across reviews; every other
 * provider sees the marker as an inert HTML comment (safe to leave or strip).
 * Pure so it is unit-testable without the server-only provider.
 */
export const CACHE_BREAKPOINT = "<!--CACHE_BREAKPOINT-->";

/** Cache TTL: "5m" (default Anthropic ephemeral) or "1h" (extended). Reviews are
 *  sporadic, so "1h" keeps the cached prefix alive across a work session for a
 *  much higher hit rate; a 1h write costs 2x base input vs 1.25x for 5m, so it
 *  pays off once the prefix is read again within the hour (active repos). */
export type CacheTtl = "5m" | "1h";

export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: CacheTtl };
};

/**
 * Split a system prompt into Anthropic system blocks. With caching on and a
 * marker present → [cached prefix, volatile suffix], skipping either side when
 * it is empty (Anthropic rejects an empty text block). A marker at the very
 * start or end therefore degrades to a single block rather than 400-ing.
 * Without a marker → a single (optionally cached) block. Any stray marker text
 * is always removed.
 */
export function splitSystemForCache(
  system: string,
  cacheSystem?: boolean,
  ttl: CacheTtl = "1h",
): SystemBlock[] {
  const cc = { type: "ephemeral" as const, ttl };
  if (cacheSystem && system.includes(CACHE_BREAKPOINT)) {
    const idx = system.indexOf(CACHE_BREAKPOINT);
    const prefix = system.slice(0, idx);
    const suffix = system.slice(idx + CACHE_BREAKPOINT.length);
    const blocks: SystemBlock[] = [];
    // Guard both sides: Anthropic rejects an empty text block, so only emit a
    // block when it has content. A marker at the very start (empty prefix) thus
    // degrades cleanly to a single uncached suffix block instead of a 400.
    if (prefix.trim()) blocks.push({ type: "text", text: prefix, cache_control: cc });
    if (suffix.trim()) blocks.push({ type: "text", text: suffix });
    if (blocks.length > 0) return blocks;
    // Extreme fallback (marker-only input): fall through to the single-block path.
  }
  const text = system.split(CACHE_BREAKPOINT).join("");
  return [{ type: "text", text, ...(cacheSystem ? { cache_control: cc } : {}) }];
}
