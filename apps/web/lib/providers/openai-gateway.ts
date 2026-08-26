import "server-only";
import OpenAI from "openai";
import type { AiCreateParams, AiResponse, AiProvider } from "./index";
import { splitReasoning } from "./reasoning";

/**
 * Shared implementation for OpenAI-compatible gateway providers (acp, opencode,
 * and future custom-endpoint providers). The base URL + bearer token can come
 * from env (deployment-trusted) OR from per-org configuration (org-admin
 * supplied). SSRF validation is applied by the caller's resolve path — only to
 * the per-org (user-supplied) URL, since env-configured gateways are operator-
 * controlled and may legitimately live on internal hosts. The baseUrl passed in
 * here is therefore already a validated, path-stripped origin.
 *
 * Caller supplies the provider name, the model-id namespace prefix to strip
 * (e.g. "acp:"), the gateway base URL, and the bearer token.
 */
export type GatewayCallOptions = {
  name: AiProvider;
  modelPrefix: string;
  /**
   * The API base INCLUDING its version segment -- `https://api.deepseek.com/v1`
   * or `https://api.z.ai/api/paas/v4`. The caller decides, because not every
   * OpenAI-compatible API is served at `/v1` and appending it here made those
   * unreachable.
   */
  apiBase: string;
  apiKey: string;
  /**
   * Vendor extensions merged into the request body.
   *
   * OpenAI-compatible is a shape, not a contract: MiniMax takes
   * `thinking: {type: "disabled"}`, and without it a review-sized prompt makes it
   * reason until the token budget is gone and no answer is ever written. Whether
   * an endpoint wants such a field is a property OF THAT ENDPOINT, so it is
   * configured beside its URL and key rather than inferred from a model name
   * here -- a vendor list in this file would need editing every time a provider
   * ships a new flag.
   *
   * Reserved keys are refused by the caller; see `parseExtraBody`.
   */
  extraBody?: Record<string, unknown>;
};

/**
 * Fields this layer computes. An operator extension may add to the request, never
 * redefine what is being asked -- a stray `messages` would silently review
 * something else, and a stray `model` would bill a different one.
 */
const RESERVED_BODY_KEYS = new Set([
  "model",
  "messages",
  "max_completion_tokens",
  "max_tokens",
  "response_format",
  "stream",
]);

/**
 * Parse an operator-supplied JSON object of vendor extensions. Throws with the
 * offending key rather than dropping it, because a silently ignored setting is
 * indistinguishable from one that did not work.
 */
export function parseExtraBody(raw: string | undefined, envName: string): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${envName} is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`);
  }
  for (const key of Object.keys(parsed)) {
    if (RESERVED_BODY_KEYS.has(key)) {
      throw new Error(
        `${envName} may not set "${key}": this layer computes it, and overriding it would ` +
          "change what is asked rather than how it is asked.",
      );
    }
  }
  return parsed as Record<string, unknown>;
}

export async function callOpenAiGateway(
  params: AiCreateParams,
  opts: GatewayCallOptions,
): Promise<AiResponse> {
  // Not cached across calls: with per-org config the base URL + token vary by
  // org, so a per-provider client singleton would leak one org's gateway/token
  // to another.
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.apiBase });

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (params.system) messages.push({ role: "system", content: params.system });
  for (const m of params.messages) messages.push({ role: m.role, content: m.content });

  const model = params.model.startsWith(opts.modelPrefix)
    ? params.model.slice(opts.modelPrefix.length)
    : params.model;

  const response = await client.chat.completions.create({
    // Extensions first, so a reserved key could never win even if one slipped
    // past parseExtraBody.
    ...(opts.extraBody ?? {}),
    model,
    max_completion_tokens: params.maxTokens,
    messages,
    ...(params.responseSchema
      ? {
          response_format: {
            type: "json_schema" as const,
            json_schema: {
              name: params.responseSchema.name,
              schema: params.responseSchema.schema,
              strict: true,
            },
          },
        }
      : {}),
  });

  const finishReason = response.choices[0]?.finish_reason ?? "unknown";
  const raw = response.choices[0]?.message?.content ?? "";

  // Gateways do not agree on where reasoning goes. MiniMax puts it inline in
  // `content`; left alone it becomes the review. See ./reasoning.ts.
  const { text, strippedReasoning, truncatedInReasoning } = splitReasoning(raw);

  if (truncatedInReasoning) {
    // Distinct from "returned nothing": the model opened a reasoning block and
    // never closed it, so the answer was never written. That is a budget
    // problem, and saying so is the difference between a fix and a retry.
    throw new Error(
      `${opts.name} gateway (${params.model}) spent its whole ${params.maxTokens}-token budget ` +
        `on reasoning and never began the answer (finish_reason: ${finishReason}). ` +
        "Raise maxTokens, or choose a model that reasons less.",
    );
  }
  // Surface an empty completion as an error instead of returning a blank review
  // that downstream code would post as an empty PR comment.
  if (!text) {
    // Empty AFTER stripping is a different diagnosis from empty to begin with:
    // the model reasoned until the budget was gone and never started the answer.
    if (strippedReasoning) {
      throw new Error(
        `${opts.name} gateway (${params.model}) used its whole ${params.maxTokens}-token budget ` +
          `on reasoning and produced no answer (finish_reason: ${finishReason}). ` +
          "Disable thinking for this endpoint via its EXTRA_BODY, or raise maxTokens.",
      );
    }
    throw new Error(
      `${opts.name} gateway returned no text (finish_reason: ${finishReason})`,
    );
  }
  if (strippedReasoning) {
    console.log(
      `[${opts.name}] stripped inline reasoning from ${params.model}: ` +
        `${raw.length} chars in, ${text.length} out`,
    );
  }

  return {
    text,
    provider: opts.name,
    model: params.model,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0,
    },
  };
}
