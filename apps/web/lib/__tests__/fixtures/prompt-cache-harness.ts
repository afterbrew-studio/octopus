import { mock } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
mock.module("server-only", () => ({}));
globalThis.fetch = (() => { throw new Error("Unexpected network access"); }) as typeof fetch;
process.env.OPENAI_API_KEY = "synthetic-platform";
process.env.PROMPT_CACHE_TTL = "5m";
process.env.PLATFORM_MARKUP = "1.2";
type Body = { prompt_cache_key?: string; prompt_cache_retention?: string; instructions?: string; input?: unknown; messages: { role: string; content: string }[];
  system: { text: string; cache_control: { type: string; ttl?: string } }[] };
const calls: { provider: string; key?: string; body: Body }[] = [];
let keys: Record<string, string | null> = {};
let anthropicWrites = 0;
let openaiWrites: number | undefined = 3000;
type StoredUsage = { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; usedOwnKey: boolean };
const stored: StoredUsage[] = [], debits: number[] = [], snapshots: number[] = [];
mock.module("@octopus/db", () => ({ prisma: {
  availableModel: { findMany: async () => [
    { modelId: "claude-opus-5-5", provider: "anthropic", inputPrice: 4, outputPrice: 20 },
    ...["o3-mini", "o3-mini-2025-01-31", "o4-mini", "o4-mini-2025-04-16"].map(modelId =>
      ({ modelId, provider: "openai", inputPrice: 1.1, outputPrice: 4.4 })),
  ] },
  organization: { findUnique: async () => keys },
  systemConfig: { findUnique: async () => null },
  aiUsage: {
    create: async ({ data }: { data: StoredUsage }) => { stored.push(data); return { id: String(stored.length) }; },
    update: async ({ where, data }: { where: { id: string }; data: { chargedCostUsd: number } }) => {
      assert.equal(where.id, String(stored.length));
      assert.deepEqual(Object.keys(data), ["chargedCostUsd"]);
      snapshots.push(data.chargedCostUsd);
      return {};
    },
  },
} }));
mock.module("../../crypto", () => ({ decryptStringMaybeLegacy: (key: string) => key }));
mock.module("../../credits", () => ({ deductCredits: async (_org: string, amount: number) => { debits.push(amount); } }));
class FakeOpenAI {
  constructor(private options: { apiKey: string }) {}
  responses = { create: async (body: unknown) => { calls.push({ provider: "responses", key: this.options.apiKey, body: body as Body }); return {
    output_text: "ok", status: "completed", usage: { input_tokens: 15000, output_tokens: 0, input_tokens_details: { cached_tokens: 10000, cache_write_tokens: openaiWrites } },
  }; } };
  chat = { completions: { create: async (body: unknown) => { calls.push({ provider: "chat", key: this.options.apiKey, body: body as Body }); return {
    choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 15000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 10000, cache_write_tokens: openaiWrites } },
  }; } } };
}
class FakeAnthropic {
  constructor(private options: { apiKey?: string }) {}
  messages = { stream: (body: unknown) => { calls.push({ provider: "anthropic", key: this.options.apiKey, body: body as Body }); return {
    async *[Symbol.asyncIterator]() {
      for (const text of ["o", "k"]) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
    },
    finalMessage: async () => ({
    content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: anthropicWrites },
  }) }; } };
}
mock.module("openai", () => ({ default: FakeOpenAI }));
mock.module("@anthropic-ai/sdk", () => ({ default: FakeAnthropic }));
const { openaiProvider } = await import("../../providers/openai");
const { anthropicProvider } = await import("../../providers/anthropic");
mock.module("../../providers", () => ({ getProvider: (name: string) => name === "openai" ? openaiProvider : anthropicProvider }));
const { createAiMessage } = await import("../../ai-router");
const { streamChat } = await import("../../chat-stream");
const { logAiUsage } = await import("../../ai-usage");
const { calcCost } = await import("../../cost");
const { substitutePromptVars } = await import("../../prompt-substitute");
const { CACHE_BREAKPOINT } = await import("../../providers/system-cache");
const template = readFileSync(new URL("../../../prompts/SYSTEM_PROMPT.md", import.meta.url), "utf8");
function system(suffix: string) {
  const vars = Object.fromEntries([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(m => [m[1], ""]));
  return substitutePromptVars(template, { ...vars, PROVIDER: "GitHub", REVIEW_LANGUAGE: "en", REVIEW_LANGUAGE_NAME: "English",
    RE_REVIEW_CONTEXT: `prior-${suffix}`, PATTERN_RULES: `rules-${suffix}`, CONFLICT_DETECTION: `conflict-${suffix}`, CODEBASE_CONTEXT: `code-${suffix}` });
}
const messages = [{ role: "user" as const, content: "initial" }, { role: "assistant" as const, content: "prior answer" }, { role: "user" as const, content: "follow-up" }];
const params = { model: "gpt-5.3-codex", maxTokens: 128, cacheSystem: true, system: system("one"), messages, effort: "medium" as const };
const first = await createAiMessage(params, "org-a");
const initial = calls.at(-1)!;
assert.match(initial.body.prompt_cache_key!, /^[a-f0-9]{64}$/);
assert.deepEqual(initial.body.input, messages);
assert.equal(first.usage.cacheWriteTokens, 3000);
assert.equal(first.usage.inputTokens, 15000);
assert.equal(initial.body.prompt_cache_retention, undefined);
await createAiMessage({ ...params, system: system("two") }, "org-a");
assert.equal(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
const anthropic = await createAiMessage({ ...params, model: "claude-opus-5-5" }, "org-a");
const a = calls.at(-1)!;
await createAiMessage({ ...params, model: "claude-opus-5-5", system: system("two") }, "org-a");
const b = calls.at(-1)!;
assert.equal(a.body.system[0].text, b.body.system[0].text);
assert.equal(a.body.system[0].cache_control.ttl, "5m");
for (const value of ["prior-one", "rules-one", "conflict-one", "code-one"]) {
  assert(a.body.system[1].text.includes(value)); assert(!a.body.system[0].text.includes(value));
}
assert.deepEqual(a.body.messages, messages);
await createAiMessage(params, "org-a");
assert.equal(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
for (const changed of [{ ...params, model: "gpt-6-astra" }, { ...params, system: "changed stable prefix" + CACHE_BREAKPOINT + "suffix" }]) {
  await createAiMessage(changed, "org-a"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
}
await createAiMessage(params, "org-b"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
keys = { openaiApiKey: "synthetic-byok" };
await createAiMessage(params, "org-a"); assert.equal(calls.at(-1)!.key, "synthetic-byok"); assert.notEqual(calls.at(-1)!.body.prompt_cache_key, initial.body.prompt_cache_key);
keys = {};
for (const changed of [{ ...params, cacheSystem: false }, { ...params, system: "" }, { ...params, system: CACHE_BREAKPOINT + "only suffix" }]) {
  await createAiMessage(changed, "org-a"); assert.equal(calls.at(-1)!.body.prompt_cache_key, undefined);
}
await createAiMessage(params, ""); assert.equal(calls.at(-1)!.body.prompt_cache_key, undefined);
const chat = await createAiMessage({ ...params, model: "gpt-6-astra" }, "org-a");
assert.equal(chat.usage.cacheWriteTokens, 3000);
assert.deepEqual(calls.at(-1)!.body.messages.slice(1), messages);
await logAiUsage({ ...anthropic.usage, provider: "anthropic", model: "claude-opus-5-5", operation: "review", organizationId: "org-a" });
assert.equal(stored.at(-1)!.inputTokens, 1000);
assert(Math.abs(debits.at(-1)! - .006 * 1.2) < 1e-12);
const rates = new Map([["gpt-6-astra", { input: 10, output: 50 }]]);
process.env.PROMPT_CACHE_TTL = "1h";
assert(Math.abs(calcCost(rates, "gpt-6-astra", 15000, 0, 10000, 3000, "openai") - .0675 * 1.2) < 1e-12);

const chatHistory = [...messages, { role: "user" as const, content: `literal ${CACHE_BREAKPOINT} in history` }];
const streamParams = { orgId: "org-a", model: "claude-opus-5-5", systemCacheable: "stable instructions", system: "dynamic context", messages: chatHistory };
anthropicWrites = 1000;
for (const ttl of ["1h", "5m", undefined]) {
  if (ttl === undefined) delete process.env.PROMPT_CACHE_TTL;
  else process.env.PROMPT_CACHE_TTL = ttl;
  const deltas: string[] = [];
  const result = await streamChat({ ...streamParams, onDelta: text => { deltas.push(text); } });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "ok");
  assert.deepEqual(deltas, ["o", "k"]);
  assert.deepEqual(calls.at(-1)!.body.messages, chatHistory);
  assert.deepEqual(calls.at(-1)!.body.system, [
    { type: "text", text: "stable instructions", cache_control: { type: "ephemeral" } },
    { type: "text", text: "dynamic context" },
  ]);
  await logAiUsage({ ...result.usage, provider: result.provider, model: streamParams.model, operation: "chat", organizationId: "org-a" });
  assert(Math.abs(debits.at(-1)! - .011 * 1.2) < 1e-12);
  assert.equal(snapshots.at(-1), debits.at(-1));
  assert.equal(stored.at(-1)!.inputTokens, 1000);
  assert.equal(stored.at(-1)!.cacheWriteTokens, 1000);
  assert(!Object.hasOwn(stored.at(-1)!, "cacheWriteTtl"));
}
process.env.PROMPT_CACHE_TTL = "1h";
const snapshotsBeforeReport = [...snapshots];
assert(Math.abs(calcCost(new Map([[streamParams.model, { input: 4, output: 20 }]]), streamParams.model, 1000, 0, 10000, 1000, "anthropic") - .014 * 1.2) < 1e-12);
assert.deepEqual(snapshots, snapshotsBeforeReport);

for (const model of ["gpt-5.3-codex", "gpt-6-astra"]) {
  const deltas: string[] = [];
  const chatParams = { ...streamParams, model, onDelta: (text: string) => { deltas.push(text); } };
  const result = await streamChat(chatParams);
  const firstChat = calls.at(-1)!;
  assert.equal(result.provider, "openai");
  assert.equal(result.text, "ok");
  assert.deepEqual(deltas, ["ok"]);
  await logAiUsage({ ...result.usage, provider: result.provider, model, operation: "chat", organizationId: "org-a" });
  assert(Math.abs(debits.at(-1)! - (model === "gpt-6-astra" ? .0675 : .0118125) * 1.2) < 1e-12);
  assert.equal(snapshots.at(-1), debits.at(-1));
  assert.equal(stored.at(-1)!.inputTokens, 15000);
  assert.equal(stored.at(-1)!.cacheWriteTokens, 3000);
  assert.match(firstChat.body.prompt_cache_key!, /^[a-f0-9]{64}$/);
  assert.equal(firstChat.body.prompt_cache_retention, undefined);
  const history = (body: Body) => body.input ?? body.messages.slice(1);
  const instructions = (body: Body) => body.instructions ?? body.messages[0].content;
  assert.deepEqual(history(firstChat.body), chatHistory);
  assert.equal(instructions(firstChat.body), `stable instructions${CACHE_BREAKPOINT}\n\ndynamic context`);
  await streamChat({ ...chatParams, system: `new ${CACHE_BREAKPOINT}context $& {{PREFIX}}` });
  assert.equal(calls.at(-1)!.body.prompt_cache_key, firstChat.body.prompt_cache_key);
  assert.equal(instructions(calls.at(-1)!.body), `stable instructions${CACHE_BREAKPOINT}\n\nnew context $& {{PREFIX}}`);
  assert.deepEqual(history(calls.at(-1)!.body), chatHistory);
  await streamChat({ ...chatParams, system: undefined });
  assert.equal(calls.at(-1)!.body.prompt_cache_key, firstChat.body.prompt_cache_key);
  await streamChat({ ...chatParams, systemCacheable: `stable ${CACHE_BREAKPOINT}changed instructions` });
  assert.notEqual(calls.at(-1)!.body.prompt_cache_key, firstChat.body.prompt_cache_key);
  assert.equal(instructions(calls.at(-1)!.body), `stable changed instructions${CACHE_BREAKPOINT}\n\ndynamic context`);
  for (const prefix of [undefined, "", CACHE_BREAKPOINT]) {
    await streamChat({ ...chatParams, systemCacheable: prefix, system: `new ${CACHE_BREAKPOINT}context` });
    assert.equal(calls.at(-1)!.body.prompt_cache_key, undefined);
    assert.equal(instructions(calls.at(-1)!.body), "new context");
  }
  await streamChat({ ...chatParams, model: "claude-opus-5-5" });
  await streamChat(chatParams);
  assert.equal(calls.at(-1)!.body.prompt_cache_key, firstChat.body.prompt_cache_key);
  keys = { openaiApiKey: "synthetic-stream-byok" };
  const byok = await streamChat(chatParams);
  assert.equal(calls.at(-1)!.key, "synthetic-stream-byok");
  assert.notEqual(calls.at(-1)!.body.prompt_cache_key, firstChat.body.prompt_cache_key);
  const debitCount = debits.length;
  await logAiUsage({ ...byok.usage, provider: byok.provider, model, operation: "chat", organizationId: "org-a" });
  assert.equal(debits.length, debitCount);
  assert.equal(stored.at(-1)!.usedOwnKey, true);
  keys = {};
}

openaiWrites = undefined;
for (const [model, expected] of [["o3-mini", .011], ["o3-mini-2025-01-31", .011], ["o4-mini", .00825], ["o4-mini-2025-04-16", .00825]] as const) {
  const result = await streamChat({ ...streamParams, model, onDelta: () => {} });
  assert.equal(result.usage.cacheWriteTokens, 0);
  await logAiUsage({ ...result.usage, provider: result.provider, model, operation: "chat", organizationId: "org-a" });
  assert(Math.abs(debits.at(-1)! - expected * 1.2) < 1e-12, model);
  assert.equal(snapshots.at(-1), debits.at(-1));
  assert.equal(stored.at(-1)!.inputTokens, 15000);
  assert.equal(stored.at(-1)!.cacheReadTokens, 10000);
}
console.log("PASS provider switching, stable prefixes, scoped affinity, retained history and cache accounting");
