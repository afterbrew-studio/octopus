/**
 * Extended-thinking configuration for Anthropic models.
 *
 * Claude-5-family models (Fable 5, Opus 5, Mythos, …) emit extended-thinking
 * blocks that spend from the max_tokens budget BEFORE any text. The small
 * review/title budgets (8192 / 256) get consumed by thinking on hard inputs, so
 * the response ends with stop_reason "max_tokens" and zero text blocks — an
 * empty review. So for these models we raise max_tokens to a floor (a ceiling,
 * not a spend — free on easy inputs) so thinking has room to finish and still
 * answer. The floor is applied ONLY to this known set: other models have lower
 * per-model max_tokens caps (e.g. 8192), and blindly raising to 64000 would get
 * a 400 rejected.
 *
 * The always-on-thinking models additionally REJECT `thinking.type: "enabled"`
 * with an explicit budget ("not supported for this model") — they require
 * `thinking.type: "adaptive"` plus `output_config.effort`. Adaptive lets the
 * model balance thinking vs. answer within max_tokens so it isn't starved.
 *
 * Kept out of anthropic.ts (which is `server-only`) so it stays unit-testable.
 */
// Models that emit always-on thinking and need the adaptive config (confirmed
// by their "use thinking.type.adaptive" API error). Opus 5 shares the Claude-5
// thinking API with Fable 5.
export const ALWAYS_THINKING_MODEL_RX = /^claude-(?:fable|mythos)-|^claude-opus-5(?:-|$)/;
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
 * Raise max_tokens to the floor for every model (so thinking can't starve the
 * answer), and for always-on-thinking models additionally set adaptive thinking
 * + an effort level.
 *
 * Adaptive is applied only on the plain-text path: the forced-`tool_choice`
 * (structured output) path keeps the floor alone and leaves thinking implicit,
 * to avoid thinking/tool_choice interactions.
 */
export function resolveThinking(
  model: string,
  requestedMaxTokens: number,
  useTool: boolean,
): ResolvedThinking {
  // Only the known thinking-heavy Claude-5 models get the floor — they have
  // high per-model caps (>= 64000) and need the room. Other models keep their
  // requested budget so we never exceed a lower cap (a 400).
  if (!ALWAYS_THINKING_MODEL_RX.test(model)) return { maxTokens: requestedMaxTokens };
  const maxTokens = Math.max(requestedMaxTokens, ALWAYS_THINKING_MAX_TOKENS_FLOOR);
  if (useTool) return { maxTokens };
  return {
    maxTokens,
    thinking: { type: "adaptive" },
    outputConfig: { effort: resolveEffort() },
  };
}
