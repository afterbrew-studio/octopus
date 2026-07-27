/**
 * Extended-thinking budget resolution for Anthropic always-thinking models.
 *
 * Claude Fable/Mythos models have always-on extended thinking that spends from
 * the max_tokens budget BEFORE any text is produced, and a tokenizer that uses
 * ~30% more tokens than Opus-tier models. Budgets tuned for other models (8192
 * for reviews, 256 for titles) get fully consumed by the thinking block on hard
 * inputs: the response ends with stop_reason "max_tokens" and zero text blocks,
 * and the whole review fails.
 *
 * Raising max_tokens to a floor is necessary but NOT sufficient — with no
 * explicit budget the thinking block can still spend the entire ceiling. So we
 * also cap the thinking budget at (max_tokens - headroom), which guarantees the
 * answer always has room. max_tokens is a ceiling, not a spend, so the floor
 * costs nothing on easy inputs.
 *
 * Kept out of anthropic.ts (which is `server-only`) so it stays unit-testable.
 */
export const ALWAYS_THINKING_MODEL_RX = /^claude-(fable|mythos)-/;
export const ALWAYS_THINKING_MAX_TOKENS_FLOOR = 64000;
export const ALWAYS_THINKING_OUTPUT_HEADROOM = 16000;

export type ResolvedThinking = {
  maxTokens: number;
  thinking?: { type: "enabled"; budget_tokens: number };
};

/**
 * For always-thinking models, raise max_tokens to the floor and cap the
 * thinking budget so text output is always reserved.
 *
 * Only on the plain-text path: forced `tool_choice` (structured output) is
 * incompatible with an explicit thinking budget, so there we keep the floor
 * alone and leave thinking implicit.
 */
export function resolveThinking(
  model: string,
  requestedMaxTokens: number,
  useTool: boolean,
): ResolvedThinking {
  if (!ALWAYS_THINKING_MODEL_RX.test(model)) return { maxTokens: requestedMaxTokens };
  const maxTokens = Math.max(requestedMaxTokens, ALWAYS_THINKING_MAX_TOKENS_FLOOR);
  if (useTool) return { maxTokens };
  return {
    maxTokens,
    thinking: { type: "enabled", budget_tokens: maxTokens - ALWAYS_THINKING_OUTPUT_HEADROOM },
  };
}
