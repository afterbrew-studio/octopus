import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * Every CLI-started review must leave an attempt behind.
 *
 * The route had two paths: an unknown pull request went through
 * `startReviewFlow`, and a known one called `processReview` directly -- skipping
 * the attempt record, so the review ran on live configuration and left nothing
 * attributable. rayf#122.
 *
 * These let the REAL `startReviewFlow` run and assert the row it writes, rather
 * than mocking it and asserting it was called. Mocking it would prove the route
 * calls a function; the property is that an attempt exists. It also keeps this
 * file from replacing `startReviewFlow` for every other file in the run, since
 * bun's module mocks are process-wide.
 */

const created: Array<Record<string, unknown>> = [];
const enqueued: Array<Record<string, unknown>> = [];
let prRow: { id: string; status: string; reviewCommentId?: number | null } | null = null;

mock.module("@octopus/db", () => ({
  prisma: {
    repository: {
      findFirst: async () => ({
        id: "repo_1",
        fullName: "afterbrew-studio/rayf",
        provider: "github",
        installationId: 1,
        isActive: true,
      }),
      findUnique: async () => ({ reviewConfig: null }),
    },
    pullRequest: {
      findFirst: async () => prRow,
      findUnique: async () => prRow,
      upsert: async () => ({ id: "pr_1", number: 134, reviewCommentId: null }),
      update: async () => ({}),
    },
    reviewAttempt: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "att_1" };
      },
    },
    systemConfig: { findUnique: async () => null },
    organization: { findUnique: async () => ({ defaultReviewConfig: null }) },
  },
}));
mock.module("@/lib/api-auth", () => ({
  authenticateApiToken: async () => ({ org: { id: "org_1" } }),
}));
mock.module("@/lib/queue", () => ({
  enqueue: async (_name: string, data: Record<string, unknown>) => {
    enqueued.push(data);
    return "job";
  },
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/github", () => ({
  getPullRequestDetails: async () => ({
    number: 134,
    title: "t",
    url: "u",
    author: "a",
    headSha: "fresh-sha",
  }),
  createComment: async () => 1,
  updateComment: async () => {},
  createCheckRun: async () => 1,
  updateCheckRun: async () => {},
}));
mock.module("@/lib/gitlab", () => ({ getPullRequestDetails: async () => ({}) }));
mock.module("@/lib/bitbucket", () => ({ getPullRequestDetails: async () => ({}) }));

const { POST } = await import("@/app/api/cli/repos/[id]/review/route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/cli/repos/repo_1/review", {
      method: "POST",
      headers: { authorization: "Bearer oct_x", "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "repo_1" }) },
  );

describe("the CLI review route creates an attempt", () => {
  beforeEach(() => {
    created.length = 0;
    enqueued.length = 0;
  });

  it("for a pull request it has never seen", async () => {
    prRow = null;
    await post({ prNumber: 134 });
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("adapter");
  });

  it("for one it already knows", async () => {
    // The regression: this path called processReview directly and created none.
    prRow = { id: "pr_1", status: "completed" };
    await post({ prNumber: 134 });
    expect(created).toHaveLength(1);
    expect(created[0]!.source).toBe("adapter");
  });

  it("and the job carries that attempt", async () => {
    prRow = { id: "pr_1", status: "completed" };
    await post({ prNumber: 134 });
    expect(enqueued[0]?.attemptId).toBe("att_1");
  });

  it("recording the head SHA it re-read, not the stored one", async () => {
    prRow = { id: "pr_1", status: "completed" };
    await post({ prNumber: 134 });
    expect(created[0]!.headSha).toBe("fresh-sha");
  });

  it("carrying a caller-supplied correlation id when one is given", async () => {
    prRow = null;
    await post({ prNumber: 134, correlationId: "req-42" });
    expect(created[0]!.correlationId).toBe("req-42");
  });

  it("and refusing outright while one is already running", async () => {
    prRow = { id: "pr_1", status: "reviewing" };
    const res = await post({ prNumber: 134 });
    expect(res.status).toBe(409);
    expect(created).toHaveLength(0);
  });
});
