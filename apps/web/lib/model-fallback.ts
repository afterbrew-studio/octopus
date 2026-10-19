import "server-only";
import { createAiMessage } from "@/lib/ai-router";
import type { AiCreateParams, AiResponse } from "@/lib/ai-router";
import { providerUnavailableReason } from "@/lib/providers/unavailable";

/**
 * `OCTOPUS_FALLBACK_MODEL` is the model a call moves to when its own model's
 * provider is unavailable (see providerUnavailableReason). Unset, nothing falls back.
 * Like the mechanical model, it only takes effect with an `available_models` row,
 * so that its usage is never recorded without a price.
 */
function configuredFallbackModel(): string | null {
  return process.env.OCTOPUS_FALLBACK_MODEL?.trim() || null;
}

async function resolveFallbackModel(failed: string): Promise<string | null> {
  const configured = configuredFallbackModel();
  if (!configured || configured === failed) return null;
  // Loaded on the failure path only; a call that succeeds never needs pricing.
  const { getModelPricing } = await import("@/lib/cost");
  const pricing = await getModelPricing().catch(() => null);
  if (!pricing?.has(configured)) {
    console.error(`[model-fallback] OCTOPUS_FALLBACK_MODEL ${configured} has no catalog row; not falling back from ${failed}`);
    return null;
  }
  return configured;
}

export interface ModelFallback {
  reason: string;
  from: string;
  to: string;
}

/**
 * Runs `attempt` on `model`; when the provider is unavailable, runs it once more on
 * the fallback model. The fallback's own failure propagates, so there is never a
 * second hop. `enabled: false` is for calls bound to one model.
 */
export async function withModelFallback<T>(
  model: string,
  attempt: (model: string) => Promise<T>,
  options: { enabled?: boolean; onFallback: (fallback: ModelFallback) => void },
): Promise<{ value: T; model: string }> {
  try {
    return { value: await attempt(model), model };
  } catch (error) {
    const reason = options.enabled === false ? null : providerUnavailableReason(error);
    const to = reason ? await resolveFallbackModel(model) : null;
    if (!reason || !to) throw error;
    options.onFallback({ reason, from: model, to });
    return { value: await attempt(to), model: to };
  }
}

/** `createAiMessage` for a call with no provenance record of its own; `model` is the one that ran. */
export async function createAiMessageWithFallback(
  params: AiCreateParams,
  orgId: string | null,
  logPrefix: string,
): Promise<{ response: AiResponse; model: string }> {
  const { value, model } = await withModelFallback(params.model, (model) => createAiMessage({ ...params, model }, orgId), {
    onFallback: ({ reason, from, to }) => console.log(`${logPrefix} Model fallback: reason=${reason} from=${from} to=${to}`),
  });
  return { response: value, model };
}
