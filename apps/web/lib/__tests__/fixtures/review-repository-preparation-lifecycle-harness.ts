import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * A repository-preparation deferral must leave its frozen `ReviewRun` alive
 * across the retry, not finalize it early -- but it must ALSO remain claimable
 * by the retry itself.
 *
 * `deferReviewForRepository` parks the pull request back at "pending", the
 * only status `processReviewInternal`'s claim query accepts unconditionally
 * (fresh-claim). "queued" would leave the retry unclaimable: that branch of
 * the claim query only matches once a row is older than the large-review
 * stale window (~35 minutes), so a 30-second-out retry would silently no-op
 * every time until the stuck-review reaper eventually swept it.
 *
 * Because "pending" is also what `attemptOutcomeForStatus` reads as a
 * finished-without-running exit, the run is kept non-terminal a different
 * way: `processReviewInternal` reports "deferred" back to `processReview`,
 * which skips finalization on that signal instead of inferring it from the
 * pull request's status.
 *
 * Drives the real `processReview`, `deferReviewForRepository`,
 * `processReviewInternal`'s own claim query (evaluated against its real
 * `where` clause, staleness included) and `attemptOutcomeForStatus` through
 * four sequences:
 *   A. defer -> retry actually claims the row -> succeeds -> run "succeeded".
 *   B. defer -> retry throws -> run "failed", not stuck non-terminal forever.
 *   C. run A defers; a newer request (run B) is admitted and reviewed at a
 *      new head/version before A's retry executes. A's retry must find its
 *      run bound to a request that no longer exists, finalize superseded,
 *      and touch nothing B already wrote -- not claim B's head under A's
 *      stale configuration and steal B's own completion.
 *   D. a deferral whose OWN guarded update misses (the pull request moved
 *      between processReviewInternal's read and the defer attempt) must
 *      finalize the run superseded, not report "deferred" for a retry that
 *      was never actually enqueued.
 */

mock.module("server-only", () => ({}));

const A = "a".repeat(40);
const org = {
  id: "org", defaultReviewConfig: {}, reviewLanguage: "en", reviewsPaused: false,
  reviewOnlyWhenCiPasses: false, githubInstallationId: 1, needsPermissionGrant: false,
};
const B = "b".repeat(40);
// Four repositories so each scenario's `ensureRepositoryAnalysis` state (which
// is keyed by repository, not by pull request) starts independently "waiting".
const repos: Record<string, { id: string; fullName: string; reviewConfig: object; provider: string; installationId: number; indexStatus: string; defaultBranch: string }> = {
  "repo-a": { id: "repo-a", fullName: "fixture/repo-a", reviewConfig: {}, provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main" },
  "repo-b": { id: "repo-b", fullName: "fixture/repo-b", reviewConfig: {}, provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main" },
  "repo-c": { id: "repo-c", fullName: "fixture/repo-c", reviewConfig: {}, provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main" },
  "repo-d": { id: "repo-d", fullName: "fixture/repo-d", reviewConfig: {}, provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main" },
};

type Row = Record<string, unknown> & { id: string; repositoryId: string; status: string; headSha: string | null; reviewRequestVersion: number; updatedAt: Date };
const prs: Record<string, Row> = {
  "pr-a": {
    id: "pr-a", repositoryId: "repo-a", number: 1, title: "Title", author: "author", url: "https://example.test/pr/1",
    headSha: A, reviewRequestVersion: 1, status: "pending", reviewBody: null, claimToken: null, updatedAt: new Date(),
  },
  "pr-b": {
    id: "pr-b", repositoryId: "repo-b", number: 2, title: "Title", author: "author", url: "https://example.test/pr/2",
    headSha: A, reviewRequestVersion: 1, status: "pending", reviewBody: null, claimToken: null, updatedAt: new Date(),
  },
  "pr-c": {
    id: "pr-c", repositoryId: "repo-c", number: 3, title: "Title", author: "author", url: "https://example.test/pr/3",
    headSha: A, reviewRequestVersion: 1, status: "pending", reviewBody: null, claimToken: null, updatedAt: new Date(),
  },
  "pr-d": {
    id: "pr-d", repositoryId: "repo-d", number: 4, title: "Title", author: "author", url: "https://example.test/pr/4",
    headSha: A, reviewRequestVersion: 1, status: "pending", reviewBody: null, claimToken: null, updatedAt: new Date(),
  },
};
// `headSha`/`reviewRequestVersion` are what the run was frozen for -- the
// binding `processReviewInternal` checks its execution against, independent
// of whatever the pull request's row says NOW.
type Run = { id: string; state: string; terminalAt: Date | null; terminalDetail: string | null; headSha: string | null; reviewRequestVersion: number | null };
const runs: Record<string, Run> = {
  "run-a": { id: "run-a", state: "pending", terminalAt: null, terminalDetail: null, headSha: A, reviewRequestVersion: 1 },
  "run-b": { id: "run-b", state: "pending", terminalAt: null, terminalDetail: null, headSha: A, reviewRequestVersion: 1 },
  "run-c": { id: "run-c", state: "pending", terminalAt: null, terminalDetail: null, headSha: A, reviewRequestVersion: 1 },
  "run-c2": { id: "run-c2", state: "pending", terminalAt: null, terminalDetail: null, headSha: B, reviewRequestVersion: 2 },
  "run-d": { id: "run-d", state: "pending", terminalAt: null, terminalDetail: null, headSha: A, reviewRequestVersion: 1 },
};

// Real staleness semantics, not a simplified stand-in: this is exactly what
// silently broke when the deferral used to park the pull request at "queued"
// instead of "pending" -- a fresh row never satisfied `{ lt: staleCutoff }`.
function conditionMatches(rowValue: unknown, condition: unknown): boolean {
  if (condition !== null && typeof condition === "object" && "lt" in (condition as Record<string, unknown>)) {
    const cutoff = (condition as { lt: Date }).lt;
    return rowValue instanceof Date && rowValue.getTime() < cutoff.getTime();
  }
  return rowValue === condition;
}
function whereMatches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "OR") continue;
    if (!conditionMatches(row[key], value)) return false;
  }
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or && !or.some((clause) => Object.entries(clause).every(([k, v]) => conditionMatches(row[k], v)))) return false;
  return true;
}
function apply(row: Row, data: Record<string, unknown>) {
  // `@updatedAt`: every write refreshes it, unless the caller supplies its own.
  Object.assign(row, structuredClone(data), { updatedAt: data.updatedAt ?? new Date() });
}

const enqueuedAfter: Array<{ pullRequestId: string; data: Record<string, unknown>; delay: number }> = [];
mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    organization: { findUnique: async () => org, update: async () => org },
    systemConfig: { findUnique: async () => null },
    repository: { findUnique: async ({ where }: { where: { id: string } }) => repos[where.id] ?? null, update: async ({ where }: { where: { id: string } }) => repos[where.id] },
    reviewIssue: { findMany: async () => [] },
    reviewAttempt: { findFirst: async () => null },
    reviewRun: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const run = runs[where.id];
        return run ? { id: run.id, configSnapshot: {}, state: run.state, headSha: run.headSha, reviewRequestVersion: run.reviewRequestVersion, terminalAt: run.terminalAt } : null;
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
      findUnique: async ({ where }: { where: { id: string } }) => {
        const row = prs[where.id];
        return row ? { ...structuredClone(row), repository: { ...repos[row.repositoryId], organization: org } } : null;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const row = prs[where.id as string];
        if (!row || !whereMatches(row, where)) return { count: 0 };
        apply(row, data);
        return { count: 1 };
      },
    },
  },
}));
mock.module("@/lib/queue", () => ({
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
  enqueue: async () => "job",
  enqueueAfter: async (_name: string, data: Record<string, unknown>, delay: number) => {
    enqueuedAfter.push({ pullRequestId: data.pullRequestId as string, data, delay });
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
// Keyed by repository, matching the real function's own signature -- each
// scenario's repository starts "waiting" independently of the other's.
const analysisReady: Record<string, boolean> = { "repo-a": false, "repo-b": false, "repo-c": false, "repo-d": false };
// Scenario D: simulates the pull request moving WHILE this (slow, real AI)
// check is in flight, by mutating it as a side effect of the check itself --
// so `deferReviewForRepository`'s guarded update, using the caller's
// already-stale snapshot, is guaranteed to miss.
let mutatePrDOnAnalysisCheck = false;
mock.module("@/lib/review-repository-preparation", () => ({
  ensureRepositoryAnalysis: async (repositoryId: string) => {
    if (repositoryId === "repo-d" && mutatePrDOnAnalysisCheck) {
      prs["pr-d"] = { ...prs["pr-d"], headSha: B, reviewRequestVersion: 2 };
    }
    return analysisReady[repositoryId] ? "ready" : "waiting";
  },
  deferReviewForRepository,
}));

mock.module("@/lib/cost", () => ({ getOrgSpendLimitStatus: async () => ({ blocked: false }), shouldGuardConcurrency: async () => false }));
const diff = "diff --git a/src/check.ts b/src/check.ts\n--- a/src/check.ts\n+++ b/src/check.ts\n@@ -1 +1 @@\n-return value;\n+return value.name;\n";
let failDiffFetch = false;
// Proves scenario C's "nothing published for A": incremented by every
// comment/review/summary call, regardless of which pull request it targets --
// a superseded execution must never reach any of them.
let publishCalls = 0;
mock.module("@/lib/github", () => ({
  LargePrError: class LargePrError extends Error {},
  getPullRequestReviewInput: async () => {
    if (failDiffFetch) throw new Error("provider unavailable");
    return { rawDiff: diff, input: {
      provider: "github", headSha: A, baseSha: "b".repeat(40), inventoryComplete: true,
      expectedFiles: 1, limitations: [],
      files: [{ path: "src/check.ts", change: "modified", patch: "@@ -1 +1 @@\n-return value;\n+return value.name;\n", additions: 1, deletions: 1 }],
    } };
  },
  getPullRequestDetails: async () => ({ body: "Title" }),
  createPullRequestComment: async () => { publishCalls++; return 123; },
  updatePullRequestComment: async () => { publishCalls++; },
  createPullRequestReview: async (..._args: unknown[]) => { publishCalls++; return 456; },
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
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => { publishCalls++; return 123; } }));

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

// A. First dispatch: repository analysis is not ready, so the review defers.
await processReview("pr-a", undefined, "run-a");
assert.equal(prs["pr-a"].status, "pending", "a deferral must leave the pull request claimable ('pending'), not 'queued'");
assert.equal(runs["run-a"].state, "running", "the run must stay non-terminal across a deferral, not be finalized");
assert.equal(runs["run-a"].terminalAt, null);
assert.equal(enqueuedAfter.filter((e) => e.pullRequestId === "pr-a").length, 1);
assert.equal(enqueuedAfter.find((e) => e.pullRequestId === "pr-a")?.data.reviewRunId, "run-a", "the retry must carry the same frozen run forward");

// A2. Retry: the SAME "pending" row, evaluated against the claim query's real
// `where` clause (including its staleness branches) -- this is what silently
// failed to match when the deferral used "queued" instead.
analysisReady["repo-a"] = true;
await processReview("pr-a", undefined, "run-a");
assert.equal(prs["pr-a"].status, "completed", "the retry must actually claim the row and complete the review");
assert.equal(runs["run-a"].state, "succeeded", "a review that succeeds on retry must be recorded as succeeded, not left cancelled by the earlier deferral");
assert.ok(runs["run-a"].terminalAt, "the run must be terminal exactly once, at the real outcome");

// B. Same defer, but the retry itself fails: the run must not be left
// non-terminal forever just because the FIRST dispatch reported "deferred".
// `processReviewInternal` catches its own execution errors and marks the pull
// request "failed" rather than throwing (see its own top-level catch), so
// this resolves normally -- the run must still end up finalized from that
// status, not stuck "running" because the earlier deferral suppressed
// finalization once already.
await processReview("pr-b", undefined, "run-b");
assert.equal(runs["run-b"].state, "running");
analysisReady["repo-b"] = true;
failDiffFetch = true;
await processReview("pr-b", undefined, "run-b");
failDiffFetch = false;
assert.equal(prs["pr-b"].status, "failed");
assert.equal(runs["run-b"].state, "failed", "a retry that fails must finalize the run as failed, not leave it stuck non-terminal");
assert.ok(runs["run-b"].terminalAt);

// C. Run A defers. While it waits, a newer request (run B, at a new head and
// version) is admitted and reviewed to completion. A's delayed retry must
// find its run bound to a request that no longer exists.
await processReview("pr-c", undefined, "run-c");
assert.equal(runs["run-c"].state, "running");

// Simulate B's admission: a fresh request at a new head/version, exactly as
// `startReviewFlowInternal` would leave the row after admitting it.
prs["pr-c"] = { ...prs["pr-c"], headSha: B, reviewRequestVersion: 2, status: "pending" };
analysisReady["repo-c"] = true; // shared per-repository state; true for both A and B now

// B's own job runs first and completes normally, under B's own binding.
await processReview("pr-c", undefined, "run-c2");
assert.equal(prs["pr-c"].status, "completed", "B must actually complete its own review");
assert.equal(runs["run-c2"].state, "succeeded");
const bClaimToken = prs["pr-c"].claimToken;
const bReviewBody = prs["pr-c"].reviewBody;
const publishCallsBeforeA = publishCalls;

// A's delayed retry finally executes: still bound to the OLD head/version.
await processReview("pr-c", undefined, "run-c");
assert.equal(runs["run-c"].state, "superseded", "A must finalize superseded, not claim B's head under A's stale configuration");
assert.ok(runs["run-c"].terminalAt);
assert.equal(prs["pr-c"].status, "completed", "A must not touch B's completed status");
assert.equal(prs["pr-c"].claimToken, bClaimToken, "A must never claim the row -- B's claim must be untouched");
assert.equal(prs["pr-c"].reviewBody, bReviewBody, "A must never publish over B's review body");
assert.equal(runs["run-c2"].state, "succeeded", "B's own outcome must be unaffected by A's late retry");
assert.equal(publishCalls, publishCallsBeforeA, "nothing may be published for a superseded run");

// D. A deferral whose OWN guarded update misses (the pull request moves
// between processReviewInternal's read and the defer attempt) must finalize
// the run superseded, not report "deferred" for a retry nothing will enqueue.
mutatePrDOnAnalysisCheck = true;
await processReview("pr-d", undefined, "run-d");
assert.equal(runs["run-d"].state, "superseded", "a defer whose guarded update misses must not be reported \"deferred\"");
assert.ok(runs["run-d"].terminalAt, "the run must not be left non-terminal forever with nothing left to retry it");
assert.equal(enqueuedAfter.filter((e) => e.pullRequestId === "pr-d").length, 0, "nothing was actually deferred, so nothing should have been enqueued");

console.log("PASS repository-preparation deferral stays claimable, preserves the run across defer-then-succeed and defer-then-fail, and finalizes superseded runs on a cross-request race or a missed guarded update");
