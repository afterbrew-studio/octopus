import { mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * A deployment with only gateway providers: the org pins one gateway model and the
 * anthropic and openai providers have no key. Import this before the code under test.
 */

export const ORG_MODEL = "opencode:glm-5.3";

export const calls: { provider: string; model: string }[] = [];
export const usage: { model: string; operation: string; provider: string }[] = [];
export const reply = { text: "ok", finish: "stop", error: null as Error | null };
/** Errors thrown for a specific model only; checked before `reply.error`. */
export const failing = new Map<string, Error>();

export const prisma: Record<string, unknown> = {
  availableModel: { findMany: async () => [], findFirst: async () => null },
  repository: { findUnique: async () => ({ reviewModelId: null }) },
  organization: {
    findUnique: async () => ({
      defaultModelId: ORG_MODEL, anthropicApiKey: null, openaiApiKey: null, googleApiKey: null,
      grokApiKey: null, openrouterApiKey: null, alibabaApiKey: null,
    }),
  },
};
mock.module("@octopus/db", () => ({ prisma, Prisma: { DbNull: null } }));

mock.module("@/lib/providers", () => ({
  getProvider: (provider: string) => ({
    create: async (params: { model: string }) => {
      calls.push({ provider, model: params.model });
      if (provider === "anthropic" || provider === "openai") throw new Error("Could not resolve authentication method");
      const failure = failing.get(params.model);
      if (failure) throw failure;
      if (reply.error) throw reply.error;
      return {
        text: reply.text, provider, model: params.model,
        completion: { state: reply.finish === "stop" ? "completed" : "incomplete", reason: reply.finish },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  }),
}));
mock.module("@/lib/ai-usage", () => ({
  logAiUsage: async (entry: { model: string; operation: string; provider: string }) => {
    usage.push({ model: entry.model, operation: entry.operation, provider: entry.provider });
  },
}));

export function reset(): void {
  calls.length = 0;
  usage.length = 0;
  reply.text = "ok";
  reply.finish = "stop";
  reply.error = null;
  failing.clear();
}

export function quiet<T>(run: () => Promise<T>): Promise<T> {
  const saved = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = () => {};
  return run().finally(() => { [console.log, console.error, console.warn] = saved; });
}
