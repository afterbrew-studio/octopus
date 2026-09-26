import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * A repository-preparation deferral must leave its frozen `ReviewRun` alive
 * across the retry, not finalize it early: `deferReviewForRepository` sets the
 * pull request to "queued" (a non-terminal status per `attemptOutcomeForStatus`),
 * matching the low-balance deferral in `reviewer.ts`, not "pending" (which
 * `attemptOutcomeForStatus` treats as an early exit and finalizes as
 * cancelled -- a terminal state a later success could never overwrite).
 *
 * Drives the real `processReview`, `deferReviewForRepository` and
 * `attemptOutcomeForStatus` through a defer-then-succeed sequence and asserts
 * the run's FINAL state, not just the re-enqueued payload.
 */

mock.module("server-only", () => ({}));

const A = "a".repeat(40);
const org = {
  id: "org", defaultReviewConfig: {}, reviewLanguage: "en", reviewsPaused: false,
  reviewOnlyWhenCiPasses: false, githubInstallationId: 1, needsPermissionGrant: false,
};
const repo = {
  id: "repo", fullName: "fixture/repo", organization: org, reviewConfig: {},
  provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main",
};

type Row = Record<string, unknown> & { id: string; status: string; headSha: string | null; reviewRequestVersion: number };
let current: Row | null = {
  id: "pr", repositoryId: "repo", number: 1, title: "Title", author: "author", url: "https://example.test/pr/1",
  headSha: A, reviewRequestVersion: 1, status: "pending", reviewBody: null, claimToken: null,
};
type Run = { id: string; state: string; terminalAt: Date | null; terminalDetail: string | null };
const runs: Record<string, Run> = { "run-1": { id: "run-1", state: "pending", terminalAt: null, terminalDetail: null } };

function matches(where: Record<string, unknown>): boolean {
  if (!current) return false;
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR" || key === "updatedAt") continue; // staleness is a separate, pre-existing concern -- not modeled here
    if (current[key] !== value) return false;
  }
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (!or) return true;
  return or.some((clause) => Object.entries(clause).every(([k, v]) => k === "updatedAt" || current![k] === v));
}
function apply(data: Record<string, unknown>) {
  assert.ok(current);
  current = { ...current, ...structuredClone(data) };
}

const enqueuedAfter: Array<{ name: string; data: Record<string, unknown>; delay: number }> = [];
mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    organization: { findUnique: async () => org, update: async () => org },
    systemConfig: { findUnique: async () => null },
    repository: { findUnique: async () => repo, update: async () => repo },
    reviewIssue: { findMany: async () => [] },
    reviewAttempt: { findFirst: async () => null },
    reviewRun: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const run = runs[where.id];
        return run ? { id: run.id, configSnapshot: {}, state: run.state } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const run = runs[where.id as string];
        if (!run) return { count: 0 };
        if (where.state !== undefined && run.state !== where.state) return { count: 0 };
        if (where.terminalAt === null && run.terminalAt !== null) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    pullRequest: {
      findUnique: async () => current ? { ...structuredClone(current), repository: { ...repo, organization: org } } : null,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
    },
  },
}));
mock.module("@/lib/queue", () => ({
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
  enqueue: async () => "job",
  enqueueAfter: async (name: string, data: Record<string, unknown>, delay: number) => {
    enqueuedAfter.push({ name, data, delay });
    return "job-1";
  },
}));
// Only `deferReviewForRepository` is exercised for real; nothing here calls
// `summarizeRepository`/`analyzeRepository` (that requires `ensureRepositoryAnalysis`,
// which is stubbed below).
mock.module("@/lib/summarizer", () => ({ summarizeRepository: async () => { throw new Error("not used by this fixture"); } }));
mock.module("@/lib/analyzer", () => ({ analyzeRepository: async () => { throw new Error("not used by this fixture"); } }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const { deferReviewForRepository } = await import("@/lib/review-repository-preparation");
let analysisReady = false;
mock.module("@/lib/review-repository-preparation", () => ({
  ensureRepositoryAnalysis: async () => (analysisReady ? "ready" : "waiting"),
  deferReviewForRepository,
}));

mock.module("@/lib/cost", () => ({ getOrgSpendLimitStatus: async () => ({ blocked: false }), shouldGuardConcurrency: async () => false }));
const diff = "diff --git a/src/check.ts b/src/check.ts\n--- a/src/check.ts\n+++ b/src/check.ts\n@@ -1 +1 @@\n-return value;\n+return value.name;\n";
mock.module("@/lib/github", () => ({
  LargePrError: class LargePrError extends Error {},
  getPullRequestReviewInput: async () => ({ rawDiff: diff, input: {
    provider: "github", headSha: A, baseSha: "b".repeat(40), inventoryComplete: true,
    expectedFiles: 1, limitations: [],
    files: [{ path: "src/check.ts", change: "modified", patch: "@@ -1 +1 @@\n-return value;\n+return value.name;\n", additions: 1, deletions: 1 }],
  } }),
  getPullRequestDetails: async () => ({ body: "Title" }),
  createPullRequestComment: async () => 123,
  updatePullRequestComment: async () => {},
  createPullRequestReview: async (..._args: unknown[]) => 456,
  createCheckRun: async () => 789,
  updateCheckRun: async () => {},
  getRepositoryTree: async () => ["src/check.ts"],
  getFileContent: async () => "return value.name;",
  listReviewComments: async () => [],
  listPullRequestReviewComments: async () => [],
  listPullRequestIssueComments: async () => [],
  listPullRequestReviews: async () => [],
  getCommentReactions: async () => ({ thumbsUp: 0, thumbsDown: 0 }),
  listOwnUnresolvedThreads: async () => [],
  resolveReviewThread: async () => {},
  createSingleReviewComment: async () => 999,
  checkStateFor: async () => "success",
}));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ slug: "fixture" }) }));
mock.module("@/lib/repo-config", () => ({
  fetchRepoConfigFile: async () => null, extractRepoConfigRules: async () => null,
  buildRepoConfigUserBlock: () => "", normalizeRepoConfigFiles: () => [],
}));
mock.module("@/lib/indexer", () => ({ indexRepository: async () => { throw new Error("unexpected indexing"); } }));
mock.module("@/lib/elasticsearch", () => ({ writeSyncLog: () => {}, deleteSyncLogs: async () => {} }));
mock.module("@/lib/qdrant", () => ({
  searchSimilarChunks: async () => [], searchKnowledgeChunks: async () => [], searchReviewChunks: async () => [],
  ensureReviewCollection: async () => {}, upsertReviewChunks: async () => {}, deleteReviewChunksByPR: async () => {},
  ensureDiagramCollection: async () => {}, upsertDiagramChunk: async () => {}, deleteDiagramChunksByPR: async () => {},
  ensureFeedbackCollection: async () => {}, upsertFeedbackPattern: async () => {},
}));
mock.module("@/lib/embeddings", () => ({ createEmbeddings: async (texts: string[]) => texts.map(() => [1, 0, 0]) }));
mock.module("@/lib/reranker", () => ({ rerankDocuments: async () => [] }));
mock.module("@/lib/knowledge-context", () => ({ getAlwaysIncludeKnowledge: async () => [], mergeKnowledgeChunks: () => [] }));
mock.module("@/lib/feedback-suppression", () => ({ suppressFindingsFromFeedback: async (findings: unknown[]) => findings }));
mock.module("@/lib/review-routing", () => ({ resolveReviewModel: async () => "fixture-model" }));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async () => {} }));
const finding = {
  severity: "🟠", title: "Missing null check", filePath: "src/check.ts", startLine: 1, endLine: 1,
  category: "Bug", description: "A missing value causes this access to throw.", suggestion: "", confidence: 95,
};
mock.module("@/lib/ai-router", () => ({
  getProviderForModel: async () => { throw new Error("Legacy fixture must not resolve adaptive capacity"); },
  createAiMessage: async () => ({
    provider: "fixture", text: `Summary\n<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify([finding])}\n<!-- OCTOPUS_FINDINGS_END -->`,
    usage: { inputTokens: 1, outputTokens: 1 },
  }),
}));
mock.module("@/lib/review-validation", () => ({
  gatherCrossFileContext: async () => "",
  gatherVerificationContext: async () => new Map(),
  validateFindings: async (findings: unknown[]) => findings,
}));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 123 }));

// `attemptOutcomeForStatus`, `updateCurrentReview` and `resolveReviewConfig` are
// the real implementations -- this fixture is precisely about their real
// interaction with `deferReviewForRepository`. Only the immutable-evidence-record
// side (irrelevant to the `ReviewRun` lifecycle under test) is stubbed.
const real = await import("@/lib/review-attempt");
mock.module("@/lib/review-attempt", () => ({
  attemptOutcomeForStatus: real.attemptOutcomeForStatus,
  updateCurrentReview: real.updateCurrentReview,
  resolveReviewConfig: real.resolveReviewConfig,
  createReviewAttemptComment: async (_id: string, _head: string, _version: number, create: () => Promise<number>) => create(),
  saveReviewAttempt: async () => false, // stop right after the "completed" write; irrelevant to this fixture
  recordFirstReviewCompletion: async () => { throw new Error("must not be reached: saveReviewAttempt stops before it"); },
  withForgejoReviewPublication: async () => { throw new Error("unexpected Forgejo publication"); },
}));

const { processReview } = await import("@/lib/reviewer");

// 1. First dispatch: repository analysis is not ready, so the review defers.
await processReview("pr", undefined, "run-1");
assert.equal(current!.status, "queued", "a deferral must leave the pull request in the non-terminal 'queued' status");
assert.equal(runs["run-1"].state, "running", "the run must stay non-terminal across a deferral, not be finalized");
assert.equal(runs["run-1"].terminalAt, null);
assert.equal(enqueuedAfter.length, 1);
assert.equal(enqueuedAfter[0]?.data.reviewRunId, "run-1", "the retry must carry the same frozen run forward");

// 2. Retry: repository analysis is now ready, and the review runs to completion.
analysisReady = true;
await processReview("pr", undefined, "run-1");
assert.equal(current!.status, "completed", "the retry must actually complete the review");
assert.equal(runs["run-1"].state, "succeeded", "a review that succeeds on retry must be recorded as succeeded, not left cancelled by the earlier deferral");
assert.ok(runs["run-1"].terminalAt, "the run must be terminal exactly once, at the real outcome");

console.log("PASS repository-preparation deferral preserves the run across a defer-then-succeed sequence");
