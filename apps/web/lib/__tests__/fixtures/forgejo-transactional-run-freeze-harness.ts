import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * The Forgejo webhook route admits and enqueues inside ONE transaction
 * (`startReviewFlowInternal`'s `forgejoTransaction` branch), which used to
 * `return` before reaching the config-freeze block written for every other
 * provider -- so every Forgejo review ran on live configuration instead of
 * the frozen run any other trigger gets. rayf P-0007 C3.
 */

const created: Array<Record<string, unknown>> = [];
let enqueuedData: Record<string, unknown> | undefined;

const A = "a".repeat(40);
const pr = {
  id: "pr-forgejo", repositoryId: "repo-forgejo", number: 1, title: "Title", author: "author",
  url: "https://forge.example/team/repo/pulls/1", headSha: A, reviewRequestVersion: 1,
  status: "pending", reviewBody: null, createdAt: new Date(),
};

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    organization: { findUnique: async () => ({ reviewsPaused: false, blockedAuthors: [], defaultReviewConfig: null }) },
    systemConfig: { findUnique: async () => null },
    repository: { findUnique: async () => ({ reviewConfig: null }) },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "run-forgejo" };
      },
    },
    pullRequest: {
      findUnique: async () => null,
      create: async () => pr,
      updateManyAndReturn: async () => [pr],
    },
  },
}));
mock.module("@/lib/forgejo", () => ({
  runWithForgejoRepository: async (_id: string, run: () => Promise<unknown>) => run(),
  getPullRequestDetails: async () => ({ headSha: A }),
  createPullRequestComment: async () => 1,
}));
mock.module("@/lib/github", () => ({
  getPullRequestDetails: async () => ({}),
  createPullRequestComment: async () => 1,
  updatePullRequestComment: async () => {},
  getInstallationToken: async () => "fixture-token",
  findPullRequestSummaryComment: async () => null,
}));
mock.module("@/lib/gitlab", () => ({ getPullRequestDetails: async () => ({}) }));
mock.module("@/lib/bitbucket", () => ({ getPullRequestDetails: async () => ({}) }));
mock.module("@/lib/queue", () => ({
  enqueue: async (_name: string, data: Record<string, unknown>) => { enqueuedData = data; return "job-1"; },
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const { startReviewFlow } = await import("../../webhook-shared");

const fakeTransaction = {
  $queryRawUnsafe: async () => [],
  pullRequest: {
    findUnique: async () => null,
    create: async () => pr,
    updateManyAndReturn: async () => [pr],
  },
} as never;

const result = await startReviewFlow({
  // "mention": the only source that both passes review-start-policy.ts AND
  // reaches this route's transactional admission with a real `@octopus`
  // comment on a Forgejo PR. ("webhook" is refused outright by this
  // deployment's policy before ever reaching the code under test.)
  source: "mention",
  provider: "forgejo",
  organizationId: "org-forgejo",
  repoFullName: "team/repo",
  repoId: "repo-forgejo",
  orgId: "org-forgejo",
  prNumber: 1,
  prTitle: "Title",
  prUrl: "https://forge.example/team/repo/pulls/1",
  prAuthor: "author",
  headSha: A,
  automatic: true,
  triggerCommentId: 0,
  triggerCommentBody: "",
}, fakeTransaction);

assert.equal(result.started, true);
assert.equal(created.length, 1, "a ReviewRun must be frozen on the Forgejo transactional path too");
assert.equal(enqueuedData?.reviewRunId, "run-forgejo", "the enqueued job must carry the frozen run, not run on live configuration");

console.log("PASS Forgejo transactional path freezes a run before enqueueing");
