import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * The policy unit test proves the predicate. This proves the thing that matters:
 * that `startReviewFlow` -- the function every webhook route calls -- reaches none
 * of its side effects for a refused source, and does not throw on the way out.
 *
 * Both halves are load-bearing. A refusal that threw would surface as a 500, which
 * the provider reads as a failed delivery and retries; a refusal that returned
 * after the upsert would leave the pull request marked pending with nothing coming.
 */

const calls: string[] = [];
const track =
  (name: string) =>
  async (..._args: unknown[]) => {
    calls.push(name);
    return undefined as never;
  };

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    pullRequest: {
      findUnique: track("prisma.pullRequest.findUnique"),
      upsert: track("prisma.pullRequest.upsert"),
      update: track("prisma.pullRequest.update"),
    },
    reviewRun: { create: track("prisma.reviewRun.create") },
    systemConfig: { findUnique: track("prisma.systemConfig.findUnique") },
    organization: { findUnique: track("prisma.organization.findUnique") },
    repository: { findUnique: track("prisma.repository.findUnique") },
  },
}));
mock.module("@/lib/queue", () => ({ enqueue: track("enqueue") }));
mock.module("@/lib/pubby", () => ({ pubby: { publish: track("pubby.publish") } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: track("eventBus.emit") } }));
mock.module("@/lib/github", () => ({
  createPullRequestComment: track("github.createPullRequestComment"),
  updatePullRequestComment: track("github.updatePullRequestComment"),
  createCheckRun: track("github.createCheckRun"),
  updateCheckRun: track("github.updateCheckRun"),
  getInstallationToken: track("github.getInstallationToken"),
  findPullRequestSummaryComment: track("github.findPullRequestSummaryComment"),
  getPullRequestDetails: track("github.getPullRequestDetails"),
}));
mock.module("@/lib/bitbucket", () => ({ getPullRequestDetails: track("bitbucket.getPullRequestDetails") }));
mock.module("@/lib/gitlab", () => ({ getPullRequestDetails: track("gitlab.getPullRequestDetails") }));
mock.module("@/lib/forgejo", () => ({
  // Complete (not a subset): bun's module mocks are process-wide, and this
  // file's mock otherwise leaks an incomplete "@/lib/forgejo" into any later
  // file in the same run that needs an export this test never calls.
  runWithForgejoRepository: async (_id: string, run: () => Promise<unknown>) => run(),
  usesForgejoConnector: () => false,
  validateForgejoConnection: track("forgejo.validateForgejoConnection"),
  listUserRepos: track("forgejo.listUserRepos"),
  getPullRequestDetails: track("forgejo.getPullRequestDetails"),
  getPullRequestReviewInput: track("forgejo.getPullRequestReviewInput"),
  createPullRequestComment: track("forgejo.createPullRequestComment"),
  updatePullRequestComment: track("forgejo.updatePullRequestComment"),
  createPullRequestReview: track("forgejo.createPullRequestReview"),
  createInlineComment: track("forgejo.createInlineComment"),
  setCommitStatus: track("forgejo.setCommitStatus"),
  getBranchHead: track("forgejo.getBranchHead"),
  getRepositoryTree: track("forgejo.getRepositoryTree"),
  getFileContent: track("forgejo.getFileContent"),
}));

const { startReviewFlow } = await import("@/lib/webhook-shared");

const params = {
  provider: "github" as const,
  installationId: 1,
  repoFullName: "afterbrew-studio/rayf",
  repoId: "repo_1",
  orgId: "org_1",
  prNumber: 42,
  prTitle: "a title",
  prUrl: "https://example.invalid/pr/42",
  prAuthor: "someone",
  headSha: "aaa111",
  triggerCommentId: 7,
  triggerCommentBody: "@octopus review",
};

describe("startReviewFlow refuses a webhook", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("returns without throwing, so the delivery is not retried", async () => {
    await startReviewFlow({ ...params, source: "webhook" });
  });

  it("touches nothing: no lookup, no upsert, no comment, no attempt, no enqueue", async () => {
    await startReviewFlow({ ...params, source: "webhook" });
    expect(calls).toEqual([]);
  });

  it("does the work for a label, which is a person asking rather than a schedule", async () => {
    await startReviewFlow({ ...params, source: "label" }).catch(() => {});
    expect(calls.length).toBeGreaterThan(0);
  });

  it("does the work for a mention too", async () => {
    await startReviewFlow({ ...params, source: "mention" }).catch(() => {});
    expect(calls.length).toBeGreaterThan(0);
  });

  it("would have done all of that for the adapter", async () => {
    // The guard test. Without it, a `startReviewFlow` that returned early for every
    // source -- or one whose mocked dependencies were simply never reached because
    // the import failed -- would pass the assertion above just as happily.
    await startReviewFlow({ ...params, source: "adapter" }).catch(() => {});
    expect(calls.length).toBeGreaterThan(0);
  });
});
