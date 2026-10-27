import { mock } from "bun:test";
import assert from "node:assert/strict";

// Own process: the provider stub and model resolution must not reach other tests.
mock.module("server-only", () => ({}));
mock.module("@/lib/cost", () => ({ isOrgOverSpendLimit: async () => false }));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async () => {} }));
mock.module("@/lib/model-fallback", () => ({ createAiMessageWithFallback: async () => { throw new Error("unused"); } }));
// A repository override beats the organization's model, exactly as the real chain resolves it.
mock.module("@/lib/ai-client", () => ({
  getEmbedModel: async (_org: string, repoId?: string) => (repoId === "repo-with-override" ? "repository-model" : "organization-model"),
}));
const searched: string[] = [];
mock.module("@/lib/qdrant", () => ({ searchSimilarChunks: async (repoId: string) => { searched.push(repoId); return []; } }));
const modelsSent: string[] = [];
const { getEmbedConfig } = await import("@/lib/embed-config");
mock.module("openai", () => {
  class StubAPIError extends Error {}
  class StubOpenAI {
    static APIError = StubAPIError;
    embeddings = {
      create: async ({ model, input }: { model: string; input: string[] }) => {
        modelsSent.push(model);
        return { data: input.map(() => ({ embedding: new Array(getEmbedConfig().dim).fill(0.1) })), usage: { prompt_tokens: 1 } };
      },
    };
  }
  return { default: StubOpenAI, APIError: StubAPIError };
});
const { gatherCrossFileContext, gatherVerificationContext } = await import("@/lib/review-validation");

const crossFile = [{ query: "where is parse used", filePath: "src/a.ts" }] as never;
const verification = [{ findingIndex: 0, query: "does b import c", filePath: "src/b.ts" }] as never;

await gatherCrossFileContext(crossFile, "repo-with-override", "org-1");
await gatherVerificationContext(verification, "repo-with-override", "org-1");
assert.deepEqual(modelsSent, ["repository-model", "repository-model"], "both verification queries embed with the repository's model");

modelsSent.length = 0;
await gatherCrossFileContext(crossFile, "repo-without-override", "org-1");
await gatherVerificationContext(verification, "repo-without-override", "org-1");
assert.deepEqual(modelsSent, ["organization-model", "organization-model"]);
assert.deepEqual(searched.slice(0, 2), ["repo-with-override", "repo-with-override"]);
console.log("Verification embedding model checks passed");
process.exit(0);
