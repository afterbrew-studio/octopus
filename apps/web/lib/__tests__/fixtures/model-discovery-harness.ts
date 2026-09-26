import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
let stored: unknown;
let writes = 0;
mock.module("@octopus/db", () => ({ prisma: {
  availableModel: { findMany: async () => [
    { modelId: "claude-opus-5", provider: "anthropic" },
    ...["openai", "grok", "alibaba"].map(provider => ({ modelId: `existing-${provider}`, provider })),
  ] },
  systemConfig: { upsert: async (args: { create: { modelDiscovery: unknown }; update: { modelDiscovery: unknown } }) => {
    assert.deepEqual(args.create.modelDiscovery, args.update.modelDiscovery);
    stored = args.update.modelDiscovery;
    writes++;
  } },
} }));

for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GROK_API_KEY", "OPENROUTER_API_KEY", "DASHSCOPE_API_KEY"]) {
  process.env[key] = "synthetic-only";
}
process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com";
process.env.OPENAI_BASE_URL = "https://api.openai.com/v1";
process.env.DASHSCOPE_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

const { refreshModelDiscovery } = await import("../../providers/model-discovery");
const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
const watchdog = setTimeout(() => { throw new Error("Discovery did not settle after its deadline or cancellation"); }, 4000);
try {
  for (const scenario of ["success", "first-body", "next-page-body", "cancelled"] as const) {
    const cancellation = new AbortController();
    const deadlines: AbortSignal[] = [];
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      assert.equal(ms, 15000);
      const signal = nativeTimeout(scenario === "cancelled" ? 3000 : 100);
      deadlines.push(signal);
      return signal;
    });
    const requests: URL[] = [];
    const stalledSignals: AbortSignal[] = [];
    const unexpected: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(url);
      if (url.hostname === "generativelanguage.googleapis.com") {
        return Response.json(url.searchParams.has("pageToken")
          ? { models: [{ name: "models/gemini-new", supportedGenerationMethods: ["generateContent"] }] }
          : { models: [], nextPageToken: "second" });
      }
      if (url.hostname === "openrouter.ai") {
        return Response.json({ data: [{ id: "deepseek/new", pricing: { prompt: "0.000001", completion: "0.000002" } }] });
      }
      const isAnthropic = url.hostname === "api.anthropic.com";
      if (isAnthropic && scenario !== "first-body" && !url.searchParams.has("after_id")) {
        return Response.json({ data: [{ id: "claude-opus-5", display_name: "Opus 5" }], has_more: true, last_id: "claude-opus-5" });
      }
      const model = {
        "api.anthropic.com": "claude-opus-5-5", "api.openai.com": "gpt-new",
        "api.x.ai": "grok-new", "dashscope-intl.aliyuncs.com": "qwen-new",
      }[url.hostname];
      if (!model || !url.pathname.endsWith("/models")) {
        unexpected.push(url.href);
        throw new Error("Unexpected request in offline discovery fixture");
      }
      if (scenario === "success") return Response.json({ data: [{ id: model, display_name: "Opus 5.5" }], has_more: false });
      const signal = init?.signal;
      assert.ok(signal);
      stalledSignals.push(signal);
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        const abort = () => controller.error(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      } });
      if (scenario === "cancelled" && stalledSignals.length === 4) {
        queueMicrotask(() => cancellation.abort(new Error("synthetic private cancellation")));
      }
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const before = writes;
      const result = await refreshModelDiscovery(cancellation.signal);
      assert.equal(writes, before + 1);
      assert.deepEqual(stored, result);
      assert.equal(deadlines.length, 1);
      assert.deepEqual(unexpected, []);
      assert.equal(requests.filter(url => url.hostname === "api.anthropic.com").length, scenario === "first-body" ? 1 : 2);
      assert.equal(requests.filter(url => url.hostname === "generativelanguage.googleapis.com").length, 2);
      assert.deepEqual(result.providers.google.newUpstream.map(model => model.id), ["gemini-new"]);
      assert.equal(result.providers.openrouter.newUpstream[0].inputPrice, 1);
      assert.equal(result.providers.openrouter.newUpstream[0].outputPrice, 2);
      for (const provider of ["anthropic", "openai", "grok", "alibaba"] as const) {
        assert.equal(result.providers[provider].keyConfigured, true);
        if (scenario === "success") {
          assert.equal(result.providers[provider].error, undefined);
          assert.equal(result.providers[provider].newUpstream.length, 1);
        } else {
          assert.equal(result.providers[provider].error, "Provider discovery failed; check provider availability and credentials.");
          assert.deepEqual(result.providers[provider].newUpstream, []);
          assert.deepEqual(result.providers[provider].inCatalogNotUpstream, []);
        }
      }
      if (scenario === "success") {
        assert.deepEqual(result.providers.anthropic.newUpstream, [{ id: "claude-opus-5-5", displayName: "Opus 5.5" }]);
        assert.deepEqual(result.providers.anthropic.inCatalogNotUpstream, []);
      } else {
        assert.equal(stalledSignals.length, 4);
        assert.ok(stalledSignals.every(signal => signal.aborted));
        assert.equal(deadlines[0].aborted, scenario !== "cancelled");
        assert.equal(cancellation.signal.aborted, scenario === "cancelled");
        assert.ok(!JSON.stringify(stored).includes("synthetic private cancellation"));
      }
    } finally {
      timeout.mockRestore();
    }
  }
} finally {
  clearTimeout(watchdog);
}
console.log("PASS discovery deadlines, pagination, cancellation and persistence");
