import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * Admission accepts an empty/null input head and resolves the authoritative
 * one itself (`currentProviderHead`) -- a "mention" trigger, for one, carries
 * no head of its own. Freezing the CALLER's input head rather than
 * admission's OWN returned pull request would bind the run to a head nobody
 * reviewed at (null, here); the worker would then find that frozen head not
 * matching the pull request's real one and finalize the run superseded
 * before ever claiming it -- on the very first execution of a brand-new run.
 */

mock.module("server-only", () => ({}));

const RESOLVED_SHA = "c".repeat(40);
type Row = Record<string, unknown> & { id: string; status: string; headSha: string | null; reviewRequestVersion: number };

let current: Row | null = null;
const runsCreated: Array<{ headSha: string | null; reviewRequestVersion: number | null }> = [];

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    organization: { findUnique: async () => ({ reviewsPaused: false, blockedAuthors: [], defaultReviewConfig: null }) },
    systemConfig: { findUnique: async () => ({ blockedAuthors: [], defaultReviewConfig: null }) },
    repository: { findUnique: async () => ({ reviewConfig: null }) },
    reviewAttempt: { findFirst: async () => null },
    pullRequest: {
      findUnique: async () => (current ? { ...current, attempts: [] } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...data, id: "pr-1", reviewRequestVersion: 1, createdAt: new Date(), updatedAt: new Date() } as Row;
        return { ...current };
      },
    },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: { headSha: string | null; reviewRequestVersion: number | null } }) => {
        runsCreated.push({ headSha: data.headSha, reviewRequestVersion: data.reviewRequestVersion });
        return { id: "run-1" };
      },
    },
  },
}));
mock.module("@/lib/github", () => ({
  // The authoritative head admission itself resolves -- distinct from the
  // input head this test deliberately passes as null.
  getPullRequestDetails: async () => ({ number: 1, title: "Title", author: "author", url: "https://example.test/pr/1", headSha: RESOLVED_SHA }),
  createPullRequestComment: async () => 1,
}));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/forgejo", () => ({ runWithForgejoRepository: async (_id: string, run: () => Promise<unknown>) => run() }));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 123 }));
mock.module("@/lib/queue", () => ({
  enqueue: async () => "job-1",
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const { startReviewFlow } = await import("../../webhook-shared");
const result = await startReviewFlow({
  source: "mention" as const,
  provider: "github" as const,
  installationId: 123,
  repoFullName: "owner/repo",
  repoId: "repo",
  orgId: "org",
  prNumber: 1,
  prTitle: "Title",
  prUrl: "https://example.test/pr/1",
  prAuthor: "author",
  headSha: null, // the caller's input head -- deliberately unknown
  triggerCommentId: 1,
  triggerCommentBody: "@octopus",
});

assert.equal(result.started, true);
assert.equal(current!.headSha, RESOLVED_SHA, "admission must have resolved and committed the authoritative head");
assert.equal(runsCreated.length, 1);
assert.equal(runsCreated[0]!.headSha, RESOLVED_SHA, "the run must be frozen for admission's OWN resolved head, not the caller's null input");
assert.equal(runsCreated[0]!.reviewRequestVersion, 1);

console.log("PASS freeze binds the run to admission's own resolved head, not the caller's input");
