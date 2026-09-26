import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { prisma } from "@octopus/db";
import { alibabaBaseUrl } from "./alibaba-request";

type DiscoveredModel = {
  id: string;
  displayName: string;
  // $/1M tokens, only when the provider API reports pricing (OpenRouter does).
  inputPrice?: number;
  outputPrice?: number;
}
export type ProviderResult = {
  keyConfigured: boolean;
  newUpstream: DiscoveredModel[]; // exist at provider, not in catalog
  inCatalogNotUpstream: string[]; // in catalog, provider no longer lists them
  error?: string;
}

function titleCase(id: string): string {
  return id
    .replace(/[-_:]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

async function discoverAnthropic(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  const client = new Anthropic({ apiKey: key, timeout: 15000, maxRetries: 0 });
  const upstream: DiscoveredModel[] = [];
  const upstreamIds = new Set<string>();
  // Auto-paginates; Anthropic's catalog is small.
  for await (const m of client.models.list({ limit: 100 }, { signal })) {
    if (upstream.length >= 1000) throw new Error("Provider catalog exceeds discovery limit");
    upstreamIds.add(m.id);
    upstream.push({ id: m.id, displayName: m.display_name || titleCase(m.id) });
  }
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    inCatalogNotUpstream: [...catalog].filter((id) => !upstreamIds.has(id)),
  };
}

async function discoverOpenAI(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  const client = new OpenAI({ apiKey: key, timeout: 15000, maxRetries: 0 });
  const list = await client.models.list({ signal });
  // OpenAI's list returns every id (embeddings, audio, snapshots). Keep only
  // chat-capable families and drop non-text + dated snapshots.
  const isChat = (id: string) =>
    /^(gpt-|o\d)/i.test(id) &&
    !/(embedding|whisper|tts|audio|realtime|image|dall|moderation|transcribe|search|instruct)/i.test(id) &&
    !/-\d{4}-\d{2}-\d{2}$/.test(id) &&
    !/-\d{4}$/.test(id);
  const upstreamIds = new Set<string>();
  const upstream: DiscoveredModel[] = [];
  for (const m of list.data) {
    if (!isChat(m.id)) continue;
    upstreamIds.add(m.id);
    upstream.push({ id: m.id, displayName: titleCase(m.id) });
  }
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    // Only flag catalog rows within the families we can see, so filtered-out
    // ids don't get falsely reported as retired.
    inCatalogNotUpstream: [...catalog].filter(
      (id) => /^(gpt-|o\d)/i.test(id) && !upstreamIds.has(id),
    ),
  };
}

async function discoverGoogle(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  const upstreamIds = new Set<string>();
  const upstream: DiscoveredModel[] = [];
  let pageToken = "";
  for (let page = 0; page < 5; page++) {
    const query = new URLSearchParams({ pageSize: "200", key, ...(pageToken ? { pageToken } : {}) });
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?${query}`, { cache: "no-store", signal });
    if (!res.ok) throw new Error("Google models API unavailable");
    const body = await res.json() as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[]; nextPageToken?: string };
    for (const m of body.models ?? []) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      const id = m.name.replace(/^models\//, "");
      if (!upstreamIds.has(id)) upstream.push({ id, displayName: m.displayName || titleCase(id) });
      upstreamIds.add(id);
    }
    pageToken = body.nextPageToken ?? "";
    if (!pageToken) break;
  }
  if (pageToken) throw new Error("Provider catalog exceeds discovery limit");
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    inCatalogNotUpstream: [...catalog].filter((id) => !upstreamIds.has(id)),
  };
}

async function discoverGrok(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.GROK_API_KEY || process.env.XAI_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  // xAI is OpenAI-compatible (same as the grok provider adapter).
  const client = new OpenAI({ apiKey: key, timeout: 15000, maxRetries: 0, baseURL: "https://api.x.ai/v1" });
  const list = await client.models.list({ signal });
  const upstreamIds = new Set<string>();
  const upstream: DiscoveredModel[] = [];
  for (const m of list.data) {
    if (!/^grok/i.test(m.id)) continue;
    upstreamIds.add(m.id);
    upstream.push({ id: m.id, displayName: titleCase(m.id) });
  }
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    inCatalogNotUpstream: [...catalog].filter((id) => !upstreamIds.has(id)),
  };
}

async function discoverAlibaba(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.DASHSCOPE_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  // DashScope compatible-mode is OpenAI-compatible (same as the alibaba provider adapter).
  const client = new OpenAI({ apiKey: key, timeout: 15000, maxRetries: 0, baseURL: alibabaBaseUrl() });
  const list = await client.models.list({ signal });
  const upstreamIds = new Set<string>();
  const upstream: DiscoveredModel[] = [];
  for (const m of list.data) {
    if (!/^qwen/i.test(m.id)) continue;
    upstreamIds.add(m.id);
    upstream.push({ id: m.id, displayName: titleCase(m.id) });
  }
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    inCatalogNotUpstream: [...catalog].filter((id) => !upstreamIds.has(id)),
  };
}

// OpenRouter lists 300+ models; surface only notable labs (plus anything Kimi)
// so the panel isn't flooded. Ids are namespaced "lab/model" (the grok/
// openrouter adapters pass them verbatim).
const OPENROUTER_LABS = new Set([
  "moonshotai",
  "x-ai",
  "deepseek",
  "qwen",
  "mistralai",
  "meta-llama",
  "cohere",
  "nvidia",
  "microsoft",
  "z-ai",
  "minimax",
  "amazon",
]);

async function discoverOpenRouter(catalog: Set<string>, signal: AbortSignal): Promise<ProviderResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { keyConfigured: false, newUpstream: [], inCatalogNotUpstream: [] };
  const res = await fetch("https://openrouter.ai/api/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store", signal,
  });
  if (!res.ok) throw new Error(`OpenRouter models API ${res.status}`);
  const body = (await res.json()) as {
    data?: { id: string; name?: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const upstream: DiscoveredModel[] = [];
  for (const m of body.data ?? []) {
    if (m.id.endsWith(":free")) continue;
    const lab = m.id.split("/")[0]?.toLowerCase() ?? "";
    if (!OPENROUTER_LABS.has(lab) && !/kimi/i.test(m.id)) continue;
    // OpenRouter prices are USD per token → $/1M tokens.
    const inP = m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1e6 : NaN;
    const outP = m.pricing?.completion ? parseFloat(m.pricing.completion) * 1e6 : NaN;
    upstream.push({
      id: m.id,
      displayName: m.name || titleCase(m.id),
      ...(isFinite(inP) && inP >= 0 ? { inputPrice: Number(inP.toFixed(3)) } : {}),
      ...(isFinite(outP) && outP >= 0 ? { outputPrice: Number(outP.toFixed(3)) } : {}),
    });
  }
  return {
    keyConfigured: true,
    newUpstream: upstream.filter((m) => !catalog.has(m.id)),
    // Filtered view — don't flag catalog rows as retired from it.
    inCatalogNotUpstream: [],
  };
}

export async function discoverModels(cancellation?: AbortSignal) {
  const rows = await prisma.availableModel.findMany({
    select: { modelId: true, provider: true },
  });
  const byProvider = (p: string) =>
    new Set(rows.filter((r) => r.provider === p).map((r) => r.modelId));
  const deadline = AbortSignal.timeout(15000);
  const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;

  // Each provider isolated: one failing (bad key, outage) must not sink the rest.
  const settle = async (fn: () => Promise<ProviderResult>): Promise<ProviderResult> => {
    try {
      return await fn();
    } catch {
      return {
        keyConfigured: true,
        newUpstream: [],
        inCatalogNotUpstream: [],
        error: "Provider discovery failed; check provider availability and credentials.",
      };
    }
  };

  const [anthropic, openai, google, grok, openrouter, alibaba] = await Promise.all([
    settle(() => discoverAnthropic(byProvider("anthropic"), signal)),
    settle(() => discoverOpenAI(byProvider("openai"), signal)),
    settle(() => discoverGoogle(byProvider("google"), signal)),
    settle(() => discoverGrok(byProvider("grok"), signal)),
    settle(() => discoverOpenRouter(byProvider("openrouter"), signal)),
    settle(() => discoverAlibaba(byProvider("alibaba"), signal)),
  ]);

  return {
    checkedAt: new Date().toISOString(),
    ok: true,
    providers: { anthropic, openai, google, grok, openrouter, alibaba },
  };
}

export async function refreshModelDiscovery(cancellation?: AbortSignal) {
  const snapshot = await discoverModels(cancellation);
  await prisma.systemConfig.upsert({ where: { id: "singleton" },
    create: { id: "singleton", modelDiscovery: snapshot }, update: { modelDiscovery: snapshot } });
  return snapshot;
}
