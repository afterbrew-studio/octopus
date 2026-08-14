import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { createAiMessage, resolveProvider } from "@/lib/ai-router";
import type { AiMessage, AiProvider } from "@/lib/providers";

/**
 * Shared chat text generation that RESOLVES THE PROVIDER from the model instead
 * of hard-coding the Anthropic client. Chat/export used to build a raw Anthropic
 * client and send the org's (possibly non-Anthropic) review model verbatim — so
 * an org pinned to Grok/OpenRouter/Google got Anthropic 404s. This routes every
 * provider correctly.
 *
 * Anthropic keeps true token streaming (the common path, unchanged). Other
 * providers have no streaming method in the provider abstraction, so we get the
 * full response through the shared router (correct provider + BYOK/platform key)
 * and emit it as a single delta — the response arrives in one chunk rather than
 * token-by-token, but it works and bills correctly. Callers still do their own
 * logAiUsage with the returned provider + usage.
 */

export interface StreamChatParams {
  orgId: string;
  model: string;
  /** Cacheable system prefix (Anthropic prompt cache); stable across turns. */
  systemCacheable?: string;
  /** Dynamic system context appended after the cacheable prefix. */
  system?: string;
  messages: AiMessage[];
  maxTokens?: number;
  /** Called for each text delta (one call total for non-Anthropic providers). */
  onDelta: (text: string) => void | Promise<void>;
}

export interface StreamChatResult {
  text: string;
  provider: AiProvider;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

let platformAnthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!platformAnthropic) {
    platformAnthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return platformAnthropic;
}

export async function streamChat(params: StreamChatParams): Promise<StreamChatResult> {
  const { orgId, model, systemCacheable, system, messages, onDelta } = params;
  const maxTokens = params.maxTokens ?? 4096;
  const provider = await resolveProvider(model);

  if (provider === "anthropic") {
    const systemBlocks = systemCacheable
      ? [
          {
            type: "text" as const,
            text: systemCacheable,
            cache_control: { type: "ephemeral" as const },
          },
          ...(system ? [{ type: "text" as const, text: system }] : []),
        ]
      : system;

    const stream = anthropicClient().messages.stream({
      model,
      max_tokens: maxTokens,
      ...(systemBlocks ? { system: systemBlocks } : {}),
      messages,
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        await onDelta(event.delta.text);
      }
    }

    const final = await stream.finalMessage();
    return {
      text,
      provider,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }

  // Non-Anthropic: single-shot through the router (no provider streaming API).
  const combinedSystem = [systemCacheable, system].filter(Boolean).join("\n\n");
  const res = await createAiMessage(
    {
      model,
      maxTokens,
      messages,
      ...(combinedSystem ? { system: combinedSystem, cacheSystem: Boolean(systemCacheable) } : {}),
    },
    orgId,
  );
  if (res.text) await onDelta(res.text);
  return { text: res.text, provider: res.provider, usage: res.usage };
}
