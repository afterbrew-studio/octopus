import type Anthropic from "@anthropic-ai/sdk";
import type { AiCreateParams } from "./index";
import { splitSystemForCache, type CacheTtl } from "./system-cache";
import { resolveThinking, resolveThinkingOverride } from "./thinking";
import { stripLoneSurrogates } from "./sanitize";
import { VALID_EFFORTS } from "./thinking";

export const usesNativeJsonOutput = (model: string) => model === "claude-opus-5-5";

/** One adapter transformation for ordinary generation and measured complete reviews. */
export function prepareAnthropicRequest(params: AiCreateParams, cacheTtl: CacheTtl): Anthropic.MessageCreateParamsStreaming {
  const nativeJson = usesNativeJsonOutput(params.model) && params.responseSchema !== undefined;
  const useTool = params.responseSchema !== undefined && !nativeJson;
  const { maxTokens, thinking, outputConfig } = resolveThinking(params.model, params.maxTokens, useTool, params.effort);
  const thinkingParam = resolveThinkingOverride(params.model, params.thinking, thinking);
  return {
    model: params.model, max_tokens: maxTokens,
    // MessageStream adds this before SDK create; include it in the admitted digest.
    stream: true,
    ...(thinkingParam ? { thinking: thinkingParam } : {}),
    ...((outputConfig || nativeJson) ? { output_config: { ...outputConfig, ...(nativeJson ? { format: { type: "json_schema" as const, schema: params.responseSchema!.schema } } : {}) } } : {}),
    system: params.system ? splitSystemForCache(stripLoneSurrogates(params.system), params.cacheSystem, cacheTtl) : undefined,
    messages: params.messages.map(message => ({ role: message.role, content: stripLoneSurrogates(message.content) })),
    ...(useTool ? {
      tools: [{ name: params.responseSchema!.name,
        description: `Return the response as a ${params.responseSchema!.name} object.`,
        input_schema: params.responseSchema!.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool" as const, name: params.responseSchema!.name },
    } : {}),
  };
}

/** Freeze the serialized body that both count projection and generation consume. */
export function freezeRequest<T>(body: T): T {
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  };
  const serialized: T = JSON.parse(JSON.stringify(body));
  freeze(serialized);
  return serialized;
}

/** The installed SDK count endpoint accepts these input fields; no other field may disappear. */
export function anthropicCountProjection(body: Anthropic.MessageCreateParamsStreaming): Anthropic.MessageCountTokensParams | null {
  const supported = new Set(["model", "messages", "system", "thinking", "output_config", "max_tokens", "stream"]);
  if (Object.keys(body).some(key => !supported.has(key))) return null;
  const only = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  if (body.stream !== true || !Array.isArray(body.messages) || body.messages.some(message => !message
    || !only(message, ["role", "content"]) || !["user", "assistant"].includes(message.role) || typeof message.content !== "string")) return null;
  if (body.system !== undefined && (!Array.isArray(body.system) || body.system.some(block => !block
    || !only(block, ["type", "text", "cache_control"]) || block.type !== "text" || typeof block.text !== "string"
    || (block.cache_control && (!only(block.cache_control, ["type", "ttl"]) || block.cache_control.type !== "ephemeral"
      || !["5m", "1h"].includes(block.cache_control.ttl ?? "5m")))))) return null;
  if (!body.thinking || !only(body.thinking, ["type"]) || body.thinking.type !== "adaptive"
    || !body.output_config || !only(body.output_config, ["effort"])
    || !VALID_EFFORTS.includes(body.output_config.effort as typeof VALID_EFFORTS[number])) return null;
  const { max_tokens: _maxTokens, stream: _stream, ...input } = body;
  return input;
}
