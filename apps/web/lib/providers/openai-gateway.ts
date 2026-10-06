import "server-only";
import { observeAiRequest, completionEvidence } from "./request-evidence";
import OpenAI from "openai";
import { Agent } from "undici";
import type { AiCreateParams, AiResponse, AiProvider } from "./index";
import { splitReasoning } from "./reasoning";
import { stripLoneSurrogates } from "./sanitize";

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

/**
 * One call's ceiling. Below the SDK's ten-minute default so a stalled gateway is
 * reported rather than sat on. `maxRetries: 0` for the same reason: the SDK
 * retrying underneath turns one review into three calls with nothing recording
 * it, and the caller's own retry policy is the one that should decide.
 */
const GATEWAY_TIMEOUT_MS = Number(process.env.GATEWAY_TIMEOUT_MS ?? 150_000);

/**
 * Keep-alive on the socket, because a review is a long SILENT wait.
 *
 * The request ships a large prompt and then nothing travels either way until the
 * vendor answers - 58-79s for a reasoning model on a review-sized diff. A path
 * that drops idle connections cannot tell that apart from a dead peer, so it
 * reaps the socket and the call surfaces as `Connection error` or, when the drop
 * is silent, hangs until the client's own timeout as `Request timed out`.
 *
 * Both were seen on GLM reviews here, and neither on MiniMax - which reaches its
 * vendor through a proxy that already sets exactly this, for exactly this
 * reason: short requests always succeeded while long ones died mid-wait. Thinking
 * is disabled for MiniMax, so its waits are short and it stays out of the window
 * this kills.
 *
 * Keep-alive gives the path something to see, so an idle-but-live connection is
 * not mistaken for a dead one.
 */
const GATEWAY_DISPATCHER = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
  connect: { keepAlive: true, keepAliveInitialDelay: 15_000 },
  // undici defaults BOTH of these to 300s, and a non-streaming review sends no
  // response header until the model has finished thinking. So five minutes was
  // the real ceiling on every call here, under whatever the SDK's own timeout
  // said - and undici reports it with the same "Request timed out." text, which
  // is why it reads as the SDK giving up.
  //
  // Tied to the gateway timeout so there is one ceiling rather than three
  // disagreeing ones.
  headersTimeout: GATEWAY_TIMEOUT_MS,
  bodyTimeout: GATEWAY_TIMEOUT_MS,
});

/**
 * How a gateway call failed, for the log: the whole error chain (the SDK reports
 * only "Connection error." and puts the real cause two levels down), whether any
 * response bytes arrived, and how long the call lasted.
 */
type AttemptTrace = { startedAt: number; responseStarted: boolean; status: number | null };

function causeChain(error: unknown): { name: string; code?: string; message: string }[] {
  const chain: { name: string; code?: string; message: string }[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const e = current as { name?: string; code?: unknown; message?: unknown; cause?: unknown };
    chain.push({
      name: typeof e.name === "string" ? e.name : typeof current,
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      message: typeof e.message === "string" ? e.message : String(current),
    });
    current = e.cause;
  }
  return chain;
}

/**
 * Failures of a connection that was never usable: a pooled keep-alive socket the
 * provider had already closed, or a reset while the request was being sent. They
 * happen before any response, and say nothing about the request itself.
 */
const STALE_SOCKET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "ECONNREFUSED"]);
const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT"]);
/** A reset this late is not a dead pooled socket: the provider may already be generating. */
const STALE_SOCKET_WINDOW_MS = 10_000;
const GATEWAY_MAX_RETRIES = 2;

/**
 * Whether this failure may be sent again. Only a connection that died before any
 * response and almost at once: never a timeout, a response that began, or an HTTP
 * status, because each of those means the provider may have worked on the request,
 * and `maxRetries: 0` exists so a long call is never repeated into the job timeout.
 */
function isStaleSocketFailure(error: unknown, trace: AttemptTrace): boolean {
  if (trace.responseStarted) return false;
  if (Date.now() - trace.startedAt > STALE_SOCKET_WINDOW_MS) return false;
  if (typeof (error as { status?: unknown }).status === "number") return false;
  const chain = causeChain(error);
  if (chain.some((link) => (link.code && TIMEOUT_CODES.has(link.code)) || /timed? ?out|abort/i.test(link.message) || /abort|timeout/i.test(link.name))) return false;
  return chain.some((link) => link.code !== undefined && STALE_SOCKET_CODES.has(link.code));
}

function retryDelayMs(attempt: number): number {
  return 150 * (attempt + 1) + Math.random() * 150;
}

export async function callOpenAiGateway(
  params: AiCreateParams,
  opts: GatewayCallOptions,
): Promise<AiResponse> {
  // Not cached across calls: with per-org config the base URL + token vary by
  // org, so a per-provider client singleton would leak one org's gateway/token
  // to another.
  // Explicit, because the SDK's own default is ten minutes - longer than the
  // stuck-review watchdog, so a slow call was restarted by the watchdog while the
  // first was still in flight and the same review ran several times over.
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.apiBase,
    timeout: GATEWAY_TIMEOUT_MS,
    maxRetries: 0,
    // `dispatcher` is undici's transport hook; the SDK's RequestInit type has
    // no field for it, so it rides through as an extra property.
    fetchOptions: { dispatcher: GATEWAY_DISPATCHER } as unknown as Record<string, never>,
    // Records whether response headers ever arrived: fetch resolves only then.
    fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await fetch(input, init);
      trace.responseStarted = true;
      trace.status = response.status;
      return response;
    },
  });
  const trace: AttemptTrace = { startedAt: Date.now(), responseStarted: false, status: null };

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (params.system) messages.push({ role: "system", content: stripLoneSurrogates(params.system) });
  for (const m of params.messages) messages.push({ role: m.role, content: stripLoneSurrogates(m.content) });

  const model = params.model.startsWith(opts.modelPrefix)
    ? params.model.slice(opts.modelPrefix.length)
    : params.model;

  const request = observeAiRequest(params, opts.name, {
    // Extensions first, so a reserved key could never win even if one slipped
    // past parseExtraBody.
    ...(opts.extraBody ?? {}),
    model,
    // BOTH spellings, because OpenAI-compatible is a shape and not a contract.
    // Z.AI ACCEPTS `max_completion_tokens` and ignores it: the reply comes back
    // `finish_reason: stop` having spent whatever it liked, indistinguishable
    // from sending no budget at all. Every review on that endpoint therefore ran
    // unbudgeted, and an unbudgeted reasoning model has no ceiling but the
    // client's own timeout.
    //
    // Measured against both endpoints in use: Z.AI honours `max_tokens` and
    // accepts the pair; MiniMax honours either and accepts the pair.
    max_completion_tokens: params.maxTokens,
    max_tokens: params.maxTokens,
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

  let response: Awaited<ReturnType<typeof client.chat.completions.create>>;
  for (let attempt = 0; ; attempt++) {
    trace.startedAt = Date.now();
    trace.responseStarted = false;
    trace.status = null;
    try {
      response = await client.chat.completions.create(request);
      break;
    } catch (error) {
      const retrying = attempt < GATEWAY_MAX_RETRIES && isStaleSocketFailure(error, trace);
      console.error(
        `[${opts.name}] gateway call failed (${params.model}, attempt ${attempt + 1}/${GATEWAY_MAX_RETRIES + 1}, ` +
          `${Date.now() - trace.startedAt}ms, responseStarted=${trace.responseStarted}, status=${trace.status ?? "none"}, ` +
          `${retrying ? "retrying on a fresh connection" : "not retrying"}):`,
        JSON.stringify(causeChain(error)),
      );
      if (!retrying) throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }

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
    completion: completionEvidence(response.choices[0]?.finish_reason, ["stop"]),
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
