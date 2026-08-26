import "server-only";

/**
 * Separate a model's reasoning from its answer.
 *
 * The Anthropic and OpenAI SDKs return reasoning in their own field, so nothing
 * downstream ever sees it. OpenAI-COMPATIBLE gateways do not agree on that:
 *
 *   - MiniMax puts the reasoning INLINE in `message.content`, wrapped in
 *     `<think>` tags (and `◁think▷` on some builds).
 *   - DeepSeek and Z.AI put it in a sibling `reasoning_content` field, which the
 *     OpenAI SDK's types do not describe, so it is silently dropped -- correct
 *     behaviour by accident.
 *
 * Untreated, the first case posts the model's entire chain of thought as the
 * review. Observed: a 32,891-character pull request comment that opened with
 * "<think>Let me analyze this PR carefully" and reported no findings, because the
 * findings parser was handed a reasoning trace instead of the structured output
 * it expects.
 *
 * So this strips reasoning rather than trusting a provider to keep it out, and it
 * does so for every gateway provider rather than for the one that was caught.
 */

/** Tag pairs seen in the wild. Both are literal text in `content`. */
const BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["<think>", "</think>"],
  ["◁think▷", "◁/think▷"],
];

export interface SplitReasoning {
  /** The answer, with reasoning removed and surrounding whitespace trimmed. */
  readonly text: string;
  /** True when anything was removed -- callers log it rather than guess. */
  readonly strippedReasoning: boolean;
  /**
   * True when the content was ONLY reasoning: an opening tag that never closed,
   * which is what a completion truncated mid-thought looks like. The answer is
   * not merely short in that case, it was never written, and a caller that
   * treats it as an empty answer would post an empty review.
   */
  readonly truncatedInReasoning: boolean;
}

export function splitReasoning(raw: string): SplitReasoning {
  let text = raw;
  let stripped = false;
  let truncated = false;

  for (const [open, close] of BLOCKS) {
    for (;;) {
      const start = text.indexOf(open);
      if (start === -1) break;
      const end = text.indexOf(close, start + open.length);
      if (end === -1) {
        // Unterminated: everything from the tag onward is reasoning that never
        // finished. Keep whatever preceded it and say so.
        text = text.slice(0, start);
        stripped = true;
        truncated = true;
        break;
      }
      text = text.slice(0, start) + text.slice(end + close.length);
      stripped = true;
    }
  }

  return { text: text.trim(), strippedReasoning: stripped, truncatedInReasoning: truncated };
}
