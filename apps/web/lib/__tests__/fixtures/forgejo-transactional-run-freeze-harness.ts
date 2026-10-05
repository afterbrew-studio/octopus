import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * The Forgejo webhook route admits and enqueues inside ONE transaction
 * (`startReviewFlowInternal`'s `forgejoTransaction` branch), which used to
 * `return` before reaching the config-freeze block written for every other
 * provider -- so every Forgejo review ran on live configuration instead of
 * the frozen run any other trigger gets. rayf P-0007 C3.
 *
 * The run must ALSO be created through that same transaction client, not the
 * global `prisma`: for a first-time PR, the run's foreign key points at a
 * pull request row that exists only inside the still-open transaction on
 * another connection. Reading/writing it through the global client blocks
 * waiting for a commit that cannot happen until this call returns, and if
 * the outer transaction ever rolls back, a run created through the global
 * client is orphaned rather than rolled back with it.
 */

let enqueuedData: Record<string, unknown> | undefined;

const A = "a".repeat(40);
const pr = {
  id: "pr-forgejo", repositoryId: "repo-forgejo", number: 1, title: "Title", author: "author",
  url: "https://forge.example/team/repo/pulls/1", headSha: A, reviewRequestVersion: 1,
  status: "pending", reviewBody: null, createdAt: new Date(),
};

// The global client must NOT be touched for the run-freeze specifically: any
// such call proves the run (or its config reads) escaped the transaction.
// The org-paused/author-blocked pre-check earlier in the SAME function is a
// separate, legitimate read of an already-committed row (not the pull
// request this run's foreign key points at), so it keeps using the global
// client -- distinguished here by its own `select` shape, since both checks
// call `organization.findUnique`.
const globalCallsNotExpected = (label: string) => async () => {
  throw new Error(`used the global prisma client for ${label} instead of the Forgejo transaction`);
};

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    organization: {
      findUnique: async ({ select }: { select: Record<string, boolean> }) => {
        if (select.defaultReviewConfig) return globalCallsNotExpected("organization.findUnique (run-freeze)")();
        return { reviewsPaused: false, blockedAuthors: [] };
      },
    },
    systemConfig: {
      findUnique: async ({ select }: { select: Record<string, boolean> }) => {
        if (select.defaultReviewConfig) return globalCallsNotExpected("systemConfig.findUnique (run-freeze)")();
        return { blockedAuthors: [] };
      },
    },
    repository: { findUnique: globalCallsNotExpected("repository.findUnique") },
    reviewRun: {
      findFirst: globalCallsNotExpected("reviewRun.findFirst"),
      create: globalCallsNotExpected("reviewRun.create"),
    },
    pullRequest: {
      findUnique: async () => null,
      createManyAndReturn: async () => [pr],
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

// The transaction client: everything the run-freeze needs must go through
// THIS object, tracked separately from the (deliberately failing) global one.
const txCreated: Array<Record<string, unknown>> = [];
const fakeTransaction = {
  $queryRawUnsafe: async () => [],
  pullRequest: {
    findUnique: async () => null,
    createManyAndReturn: async () => [pr],
    updateManyAndReturn: async () => [pr],
  },
  organization: { findUnique: async () => ({ reviewsPaused: false, blockedAuthors: [], defaultReviewConfig: null }) },
  systemConfig: { findUnique: async () => null },
  repository: { findUnique: async () => ({ reviewConfig: null }) },
  reviewRun: {
    findFirst: async () => null,
    create: async ({ data }: { data: Record<string, unknown> }) => {
      txCreated.push(data);
      return { id: "run-via-tx" };
    },
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
assert.equal(txCreated.length, 1, "a ReviewRun must be frozen through the SAME transaction, not the global client");
assert.equal(enqueuedData?.reviewRunId, "run-via-tx", "the enqueued job must carry the run created through the transaction");

console.log("PASS Forgejo transactional path freezes a run through its own transaction client");
