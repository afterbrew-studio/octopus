import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: the embedding provider is chosen through process-wide environment variables.
mock.module("server-only", () => ({}));
process.env.OCTOPUS_EMBED_PROVIDER = "ollama";
process.env.OCTOPUS_EMBED_MODEL = "nomic-embed-text";
process.env.OCTOPUS_OLLAMA_BASE_URL = "http://localhost:11434";
process.env.SELF_HOSTED = "true";
mock.module("@/lib/cost", () => ({ isOrgOverSpendLimit: async () => false }));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async () => {} }));
mock.module("@/lib/ai-client", () => ({ getEmbedModel: async () => "unused" }));
const { createEmbeddings } = await import("@/lib/embeddings");
const { INDEX_SILENCE_LIMIT_MS, throttledHeartbeat } = await import("@/lib/index-liveness");

let clock = 1_000_000;
let requests = 0;
let requestSeconds = 0;
let hang = false;
const seenSignals: Array<AbortSignal | null | undefined> = [];
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  requests++;
  seenSignals.push(init?.signal);
  if (hang) {
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
  }
  clock += requestSeconds * 1000;
  const input = JSON.parse(String(init?.body)).input as string[];
  return Response.json({ embeddings: input.map(() => new Array(768).fill(0.1)) });
}) as typeof fetch;

const texts = Array.from({ length: 320 }, (_, i) => `chunk ${i}`);

// Without progress options a request carries no signal: existing callers are unchanged.
assert.equal((await createEmbeddings(texts.slice(0, 2))).length, 2);
assert.equal(seenSignals[0], undefined);

// One call that is slow overall (5 requests of 4 minutes) but always making progress keeps its heartbeat inside the silence limit.
requests = 0; requestSeconds = 240;
const touches: number[] = [];
const beat = throttledHeartbeat(async () => { touches.push(clock); }, () => clock);
const started = clock;
const vectors = await createEmbeddings(texts, undefined, { onRequest: beat });
assert.equal(vectors.length, texts.length);
assert.equal(requests, 5);
assert.ok(clock - started > INDEX_SILENCE_LIMIT_MS, "the call itself outlasts the silence limit");
assert.ok(touches.length >= 4, `heartbeat between provider requests, got ${touches.length}`);
for (let i = 1; i < touches.length; i++) assert.ok(touches[i] - touches[i - 1] < INDEX_SILENCE_LIMIT_MS);
assert.ok(seenSignals.slice(-5).every(signal => signal), "each provider request has a deadline");

// Cancelling mid-request ends the call without further requests.
requests = 0; hang = true;
const controller = new AbortController();
const cancelled = createEmbeddings(texts, undefined, { signal: controller.signal });
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(requests, 1);
controller.abort(new Error("cancelled"));
await assert.rejects(cancelled, /cancelled/);
assert.equal(requests, 1);
console.log("Embedding liveness checks passed");
process.exit(0);
