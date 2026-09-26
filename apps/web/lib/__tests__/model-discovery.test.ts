import { afterAll, expect, it, mock } from "bun:test";
mock.module("server-only", () => ({}));
let stored: unknown;
const write = mock(async (args: { update: { modelDiscovery: unknown } }) => { stored = args.update.modelDiscovery; });
mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma: { availableModel: { findMany: async () => [{ modelId: "claude-opus-5", provider: "anthropic" }] }, systemConfig: { upsert: write } } }));
let fail = false;
mock.module("@anthropic-ai/sdk", () => ({ default: class { models = { async *list() { if (fail) throw Error("secret-provider-body"); yield { id: "claude-opus-5", display_name: "Opus 5" }; yield { id: "claude-opus-5-5", display_name: "Opus 5.5" }; } }; } }));
const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GROK_API_KEY", "XAI_API_KEY", "OPENROUTER_API_KEY", "DASHSCOPE_API_KEY"];
const prior = keys.map(k => process.env[k]);
for (const key of keys) delete process.env[key];
process.env.ANTHROPIC_API_KEY = "synthetic-only";
afterAll(() => keys.forEach((k, i) => { if (prior[i] === undefined) delete process.env[k]; else process.env[k] = prior[i]; }));
const { refreshModelDiscovery } = await import("../providers/model-discovery");
it("bounds full SDK body reads and pagination, and persists cancelled discovery", async () => {
  const child = Bun.spawn(["bun", "lib/__tests__/fixtures/model-discovery-harness.ts"], {
    cwd: import.meta.dir + "/../..", stdout: "pipe", stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ exit, stderr, stdout: stdout.trim() }).toEqual({ exit: 0, stderr: "", stdout: "PASS discovery deadlines, pagination, cancellation and persistence" });
});
it("persists discovered models without creating or activating catalog rows", async () => {
  const result = await refreshModelDiscovery();
  expect(result.providers.anthropic.newUpstream).toEqual([{ id: "claude-opus-5-5", displayName: "Opus 5.5" }]);
  expect(result.providers.anthropic.inCatalogNotUpstream).toEqual([]);
  expect(result.providers.openai.keyConfigured).toBe(false);
  expect(stored).toEqual(result);
  expect(write).toHaveBeenCalledTimes(1);
});
it("records a failed provider explicitly without leaking its error or retiring models", async () => {
  fail = true;
  const result = await refreshModelDiscovery();
  expect(result.providers.anthropic.error).toBe("Provider discovery failed; check provider availability and credentials.");
  expect(result.providers.anthropic.inCatalogNotUpstream).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("secret-provider-body");
});
it("follows Google pages before publishing discovery results", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  process.env.GOOGLE_API_KEY = "synthetic-only";
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = String(input); urls.push(url);
    return Response.json(url.includes("pageToken=second")
      ? { models: [{ name: "models/gemini-new", supportedGenerationMethods: ["generateContent"] }] }
      : { models: [], nextPageToken: "second" });
  }) as unknown as typeof fetch;
  try {
    const result = await refreshModelDiscovery();
    expect(urls).toHaveLength(2);
    expect(result.providers.google.newUpstream.map(m => m.id)).toEqual(["gemini-new"]);
  } finally { globalThis.fetch = originalFetch; delete process.env.GOOGLE_API_KEY; }
});
