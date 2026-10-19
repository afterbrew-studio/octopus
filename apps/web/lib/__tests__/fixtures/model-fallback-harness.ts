import { mock } from "bun:test";
import assert from "node:assert/strict";
import { calls, usage, reply, failing, reset, ORG_MODEL, prisma } from "./gateway-only";

/**
 * OCTOPUS_FALLBACK_MODEL through the real router: the provider error reaches the classifier as the
 * router wraps it, and the validation pass and repo-config extractor move to the fallback once.
 */

const FALLBACK = "acp:deepseek-v4-pro";
const priced = new Set<string>();
mock.module("@/lib/cost", () => ({ getModelPricing: async () => new Map([...priced].map(model => [model, { input: 0, output: 0 }])) }));
mock.module("@/lib/qdrant", () => ({ searchSimilarChunks: async () => [] }));
mock.module("@/lib/embeddings", () => ({ createEmbeddings: async () => [] }));
Object.assign(prisma, {
  repoConfigExtraction: { findUnique: async () => null, create: async () => ({}) },
});

const { validateFindings } = await import("@/lib/review-validation");
const { extractRepoConfigRules } = await import("@/lib/repo-config");

const finding = {
  severity: "🟠", title: "Missing null check", filePath: "src/check.ts", startLine: 1, endLine: 1,
  category: "Bug", description: "A missing value causes this access to throw.", suggestion: "", confidence: 90,
};
const REFUTED = '[{"index": 0, "confidence": 12, "refutation": "guarded above"}]';
const http = (status: number) => Object.assign(new Error(`${status} fixture provider failure`), { status });
const connectionReset = Object.assign(new Error("Connection error."), {
  cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }),
});
const validate = (model = ORG_MODEL) => validateFindings([finding], "diff --git a/x b/x", "org", model, 70);
const extract = () => extractRepoConfigRules("repo", "org", { source: "AGENTS.md", rawContent: "- Use tabs.", contentHash: "h", truncated: false });
const logged: string[] = [];
const errors: string[] = [];
const log = console.log;
const error = console.error;
console.log = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
console.error = (...parts: unknown[]) => { errors.push(parts.join(" ")); };
const begin = () => { reset(); logged.length = 0; errors.length = 0; reply.text = REFUTED; };
const providers = () => calls.map(call => `${call.provider}:${call.model}`);

delete process.env.OCTOPUS_VALIDATION_MODEL;
delete process.env.OCTOPUS_FALLBACK_MODEL;
begin();
failing.set(ORG_MODEL, http(429));
await assert.rejects(validate(), /429/, "unset: an unavailable provider fails the validation as before");
assert.equal(calls.length, 1);

process.env.OCTOPUS_FALLBACK_MODEL = `  ${FALLBACK}  `;
priced.add(FALLBACK);

begin();
failing.set(ORG_MODEL, http(429));
assert.deepEqual(await validate(), [], "the validation falls back and its verdict is applied");
assert.deepEqual(providers(), [`opencode:${ORG_MODEL}`, `acp:${FALLBACK}`], "one call on each provider, through the real router");
assert.deepEqual(usage.map(u => [u.model, u.operation]), [[FALLBACK, "review-validation"]], "usage is recorded against the model that ran");
assert.deepEqual(logged.filter(line => line.includes("fallback")), [`[review-validation] Model fallback: reason=429 from=${ORG_MODEL} to=${FALLBACK}`]);

begin();
failing.set(ORG_MODEL, http(503));
await validate();
assert.deepEqual(providers(), [`opencode:${ORG_MODEL}`, `acp:${FALLBACK}`], "a 5xx falls back");

begin();
failing.set(ORG_MODEL, connectionReset);
await validate();
assert.deepEqual(providers(), [`opencode:${ORG_MODEL}`, `acp:${FALLBACK}`], "a connection error nested under the router's wrapper falls back");
assert.ok(logged.some(line => line.includes("reason=connection")));

for (const status of [400, 401, 403]) {
  begin();
  failing.set(ORG_MODEL, http(status));
  await assert.rejects(validate(), new RegExp(String(status)), `a ${status} never falls back`);
  assert.equal(calls.length, 1);
}

begin();
failing.set(ORG_MODEL, http(429));
failing.set(FALLBACK, http(429));
await assert.rejects(validate(), /429/, "a fallback that is also unavailable fails the call");
assert.equal(calls.length, 2, "exactly one hop");

begin();
failing.set(FALLBACK, http(429));
await assert.rejects(validate(FALLBACK), /429/, "the fallback model is never its own fallback");
assert.equal(calls.length, 1);

begin();
priced.delete(FALLBACK);
failing.set(ORG_MODEL, http(429));
await assert.rejects(validate(), /429/, "a fallback with no catalog row is not used");
assert.equal(calls.length, 1);
assert.ok(errors.some(line => line.includes(`OCTOPUS_FALLBACK_MODEL ${FALLBACK} has no catalog row`)), "and the missing row is logged");
priced.add(FALLBACK);

begin();
reply.text = "- Use tabs.";
failing.set(ORG_MODEL, http(429));
const extracted = await extract();
assert.equal(extracted?.rules, "- Use tabs.", "the extractor falls back");
assert.deepEqual(providers(), [`opencode:${ORG_MODEL}`, `acp:${FALLBACK}`]);
assert.deepEqual(usage.map(u => [u.model, u.operation]), [[FALLBACK, "repo-config-extract"]]);

console.log = log;
console.error = error;
console.log("PASS fallback model replaces an unavailable provider");
