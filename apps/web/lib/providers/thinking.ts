/**
 * Extended-thinking configuration for Anthropic always-thinking models.
 *
 * Claude Fable/Mythos models have always-on extended thinking that spends from
 * the max_tokens budget BEFORE any text. With NO thinking config, a hard input's
 * thinking block fills the whole ceiling → stop_reason "max_tokens", zero text,
 * empty review. But these models also REJECT `thinking.type: "enabled"` with an
 * explicit budget ("not supported for this model") — they require
 * `thinking.type: "adaptive"` plus `output_config.effort` to control how much
 * they think. Adaptive lets the model balance thinking vs. answer within
 * max_tokens so the response is never starved.
 *
 * We still raise max_tokens to a floor (a ceiling, not a spend — free on easy
 * inputs) to give adaptive thinking room to work.
 *
 * Kept out of anthropic.ts (which is `server-only`) so it stays unit-testable.
 */
export const ALWAYS_THINKING_MODEL_RX = /^claude-(fable|mythos)-/;
export const ALWAYS_THINKING_MAX_TOKENS_FLOOR = 64000;

export type ThinkingEffort = "low" | "medium" | "high" | "xhigh" | "max";
const VALID_EFFORTS: readonly ThinkingEffort[] = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = "high";

/** Effort knob, env-tunable without a redeploy (FABLE_THINKING_EFFORT). */
export function resolveEffort(): ThinkingEffort {
  const v = process.env.FABLE_THINKING_EFFORT;
  return v && (VALID_EFFORTS as readonly string[]).includes(v)
    ? (v as ThinkingEffort)
    : DEFAULT_THINKING_EFFORT;
}

export type ResolvedThinking = {
  maxTokens: number;
  thinking?: { type: "adaptive" };
  outputConfig?: { effort: ThinkingEffort };
};

/**
 * For always-thinking models, raise max_tokens to the floor and set adaptive
 * thinking + an effort level so the answer is never starved.
 *
 * Only on the plain-text path: the forced-`tool_choice` (structured output) path
 * keeps the floor alone and leaves thinking implicit, to avoid thinking/
 * tool_choice interactions.
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
    thinking: { type: "adaptive" },
    outputConfig: { effort: resolveEffort() },
  };
}
