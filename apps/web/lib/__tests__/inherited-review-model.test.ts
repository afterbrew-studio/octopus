import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * A review keeps the model its labels asked for, across every later trigger.
 *
 * Only the `label` event carries the label that was just added, so it was the
 * only caller that resolved a model. A push, an `@octopus` mention and the
 * stuck-review restart passed none and fell through to the deployment default,
 * which silently downgraded a `complexity:strong` change to the mid tier for
 * every review after its first.
 *
 * The REAL `startReviewFlow` runs here and the attempt row it writes is
 * asserted. Mocking it would prove a caller calls a function; the property is
 * which model the frozen snapshot records.
 */

const created: Array<Record<string, unknown>> = [];
let attempts: Array<{ configSnapshot: unknown }> = [];

mock.module("@octopus/db", () => ({
  prisma: {
    repository: {
      findUnique: async () => ({ reviewConfig: null }),
      update: async () => ({}),
    },
    pullRequest: {
      findUnique: async () => null,
      upsert: async () => ({ id: "pr_1", number: 646, reviewCommentId: 7 }),
      update: async () => ({}),
    },
    reviewAttempt: {
      // Newest first, matching the orderBy the lookup asks for.
      findFirst: async () => attempts[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "att_1" };
      },
    },
    systemConfig: { findUnique: async () => null },
    organization: { findUnique: async () => ({ defaultReviewConfig: null }) },
  },
}));
mock.module("@/lib/queue", () => ({ enqueue: async () => "job" }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/github", () => ({
  createComment: async () => 1,
  updateComment: async () => {},
  updatePullRequestComment: async () => {},
  createCheckRun: async () => 1,
  updateCheckRun: async () => {},
}));

const { startReviewFlow } = await import("@/lib/webhook-shared");

const start = (over: Record<string, unknown>) =>
  startReviewFlow({
    provider: "github",
    installationId: 1,
    repoFullName: "afterbrew-studio/rayf",
    repoId: "repo_1",
    orgId: "org_1",
    prNumber: 646,
    prTitle: "t",
    prUrl: "u",
    prAuthor: "shhr3y",
    headSha: "abc1234",
    triggerCommentId: 0,
    triggerCommentBody: "",
    ...over,
  } as Parameters<typeof startReviewFlow>[0]);

const modelOf = (row: Record<string, unknown>) =>
  (row.configSnapshot as { modelOverride?: string }).modelOverride;

describe("the model a review was asked to use", () => {
  beforeEach(() => {
    created.length = 0;
    attempts = [];
  });

  it("is recorded when the label event resolves one", async () => {
    await start({ source: "label", modelOverride: "opencode:glm-5.3" });
    expect(modelOf(created[0]!)).toBe("opencode:glm-5.3");
  });

  it("survives a restart the dispatcher asks for", async () => {
    // The regression, exactly: rayf #646's `label` attempt resolved
    // `opencode:glm-5.3` and timed out, then three `adapter` attempts carried no
    // model and the review that landed was written by the deployment default.
    attempts = [{ configSnapshot: { modelOverride: "opencode:glm-5.3" } }];
    await start({ source: "adapter" });
    expect(modelOf(created[0]!)).toBe("opencode:glm-5.3");
  });

  it("survives an @octopus mention", async () => {
    attempts = [{ configSnapshot: { modelOverride: "opencode:glm-5.3" } }];
    await start({ source: "mention" });
    expect(modelOf(created[0]!)).toBe("opencode:glm-5.3");
  });

  it("yields to an explicit override, which is a fresher ask", async () => {
    attempts = [{ configSnapshot: { modelOverride: "opencode:glm-5.3" } }];
    await start({ source: "label", modelOverride: "acp:MiniMax-M3" });
    expect(modelOf(created[0]!)).toBe("acp:MiniMax-M3");
  });

  it("stays unset when no attempt ever recorded one", async () => {
    // A repository that does not key models on labels must keep falling through
    // to the deployment default.
    attempts = [{ configSnapshot: {} }];
    await start({ source: "adapter" });
    expect(modelOf(created[0]!)).toBeUndefined();
  });

  it("ignores a snapshot that is not an object", async () => {
    attempts = [{ configSnapshot: null }];
    await start({ source: "adapter" });
    expect(modelOf(created[0]!)).toBeUndefined();
  });
});
