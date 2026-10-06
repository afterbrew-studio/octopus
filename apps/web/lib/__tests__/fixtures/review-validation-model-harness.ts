import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * The validation pass runs on the model the review resolved, through the real router,
 * so a review on a gateway model never reaches a vendor this deployment has no key for.
 */

mock.module("@octopus/db", () => ({
  prisma: { availableModel: { findMany: async () => [] }, organization: { findUnique: async () => null } },
}));
const calls: { provider: string; model: string }[] = [];
const usage: string[] = [];
mock.module("@/lib/providers", () => ({
  getProvider: (provider: string) => ({
    create: async (params: { model: string }) => {
      calls.push({ provider, model: params.model });
      // The anthropic provider has no key here, exactly as on the deployment this guards.
      if (provider === "anthropic") throw new Error("Could not resolve authentication method");
      return {
        text: '[{"index": 0, "confidence": 12, "refutation": "guarded above"}]', provider, model: params.model,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  }),
}));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async (entry: { model: string }) => { usage.push(entry.model); } }));
mock.module("@/lib/qdrant", () => ({ searchSimilarChunks: async () => [] }));
mock.module("@/lib/embeddings", () => ({ createEmbeddings: async () => [] }));

const { validateFindings } = await import("@/lib/review-validation");
const finding = {
  severity: "🟠", title: "Missing null check", filePath: "src/check.ts", startLine: 1, endLine: 1,
  category: "Bug", description: "A missing value causes this access to throw.", suggestion: "", confidence: 90,
};
const validate = (reviewModel: string) => validateFindings([finding], "diff --git a/x b/x", "org", reviewModel, 70);
const quiet = console.log;
console.log = () => {};

delete process.env.OCTOPUS_VALIDATION_MODEL;
const outcome = await validate("opencode:glm-5.3").then((findings) => ({ findings }), (error: Error) => ({ error }));
assert.ok(!("error" in outcome), `validation must not fail for a review whose provider has a key: ${"error" in outcome ? outcome.error.message : ""}`);
const kept = outcome.findings;
assert.deepEqual(calls, [{ provider: "opencode", model: "opencode:glm-5.3" }], "validation runs on the review's own model, through its own provider");
assert.equal(calls.some((call) => call.provider === "anthropic"), false, "a review on an opencode: model never reaches the anthropic provider");
assert.deepEqual(usage, ["opencode:glm-5.3"], "usage is attributed to the model that ran");
assert.deepEqual(kept, [], "and the false-positive filter actually ran: the refuted finding is dropped");

calls.length = 0; usage.length = 0;
await validate("gpt-fixture");
assert.deepEqual(calls, [{ provider: "openai", model: "gpt-fixture" }], "another review model is used as is");

calls.length = 0; usage.length = 0;
process.env.OCTOPUS_VALIDATION_MODEL = "  gpt-validator  ";
await validate("opencode:glm-5.3");
assert.deepEqual(calls, [{ provider: "openai", model: "gpt-validator" }], "an operator's validator wins over the review's model");
assert.deepEqual(usage, ["gpt-validator"]);

calls.length = 0;
process.env.OCTOPUS_VALIDATION_MODEL = "   ";
await validate("opencode:glm-5.3");
assert.deepEqual(calls, [{ provider: "opencode", model: "opencode:glm-5.3" }], "a blank override is no override, and never a hardcoded vendor");

console.log = quiet;
console.log("PASS validation runs on the review's model unless an operator pins one");
