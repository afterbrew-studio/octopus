import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * Reply classification runs on the model the repo or org is configured for, through the real
 * router, so a deployment with only gateway providers never reaches a vendor it has no key for.
 */

const prisma = {
  availableModel: { findMany: async () => [], findFirst: async () => null },
  repository: {
    findUnique: async ({ where }: { where: { id: string } }) => ({
      reviewModelId: where.id === "repo-pinned" ? "opencode:glm-5.3" : null,
    }),
  },
  organization: { findUnique: async () => ({ defaultModelId: "acp:org-model" }) },
};
mock.module("@octopus/db", () => ({ prisma }));

const calls: { provider: string; model: string }[] = [];
const usage: string[] = [];
let reply = '["dismissed","accepted"]';
mock.module("@/lib/providers", () => ({
  getProvider: (provider: string) => ({
    create: async (params: { model: string }) => {
      calls.push({ provider, model: params.model });
      // The anthropic provider has no key here, exactly as on the deployment this guards.
      if (provider === "anthropic") throw new Error("Could not resolve authentication method");
      return {
        text: reply, provider, model: params.model,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  }),
}));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async (entry: { model: string }) => { usage.push(entry.model); } }));

const { classifyReplyIntents } = await import("@/lib/reviewer");
const entries = [
  { findingTitle: "Missing null check", replyText: "False positive, the caller guards this." },
  { findingTitle: "Unused import", replyText: "Good catch, fixing." },
];
const quiet = [console.log, console.error];
console.log = () => {};
console.error = () => {};

const pinned = await classifyReplyIntents(entries, "org", "repo-pinned");
assert.deepEqual(calls, [{ provider: "opencode", model: "opencode:glm-5.3" }], "the repo's pinned model is used, through its own provider");
assert.deepEqual(pinned, ["dismissed", "accepted"], "the reply is classified rather than falling back to unclear");
assert.deepEqual(usage, ["opencode:glm-5.3"], "usage is attributed to the model that ran");

calls.length = 0; usage.length = 0;
await classifyReplyIntents(entries, "org", "repo-unpinned");
assert.deepEqual(calls, [{ provider: "acp", model: "acp:org-model" }], "an unpinned repo uses the org's model");
assert.equal(calls.some((call) => call.provider === "anthropic"), false, "classification never reaches the anthropic provider");

calls.length = 0; usage.length = 0;
reply = 'Reasoning done.\n```json\n["accepted","unclear"]\n```';
assert.deepEqual(await classifyReplyIntents(entries, "org", "repo-pinned"), ["accepted", "unclear"], "a fenced array is parsed");

console.log = quiet[0];
console.error = quiet[1];
console.log("PASS reply classification runs on the configured model");
