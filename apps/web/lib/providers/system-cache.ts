/**
 * Prompt-cache breakpoint support (#650). The review system prompt carries a
 * marker splitting the stable, cacheable instruction/rulepack prefix from the
 * per-review volatile context. The Anthropic provider turns the marker into a
 * `cache_control` breakpoint so the prefix is reused across reviews; every other
 * provider sees the marker as an inert HTML comment (safe to leave or strip).
 * Pure so it is unit-testable without the server-only provider.
 */
export const CACHE_BREAKPOINT = "<!--CACHE_BREAKPOINT-->";

export type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

/**
 * Split a system prompt into Anthropic system blocks. With caching on and a
 * marker present → [cached prefix, volatile suffix]. Without a marker → a single
 * (optionally cached) block. Any stray marker text is always removed.
 */
export function splitSystemForCache(system: string, cacheSystem?: boolean): SystemBlock[] {
  if (cacheSystem && system.includes(CACHE_BREAKPOINT)) {
    const idx = system.indexOf(CACHE_BREAKPOINT);
    const prefix = system.slice(0, idx);
    const suffix = system.slice(idx + CACHE_BREAKPOINT.length);
    const blocks: SystemBlock[] = [
      { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    ];
    if (suffix.trim()) blocks.push({ type: "text", text: suffix });
    return blocks;
  }
  const text = system.split(CACHE_BREAKPOINT).join("");
  return [{ type: "text", text, ...(cacheSystem ? { cache_control: { type: "ephemeral" } } : {}) }];
}
