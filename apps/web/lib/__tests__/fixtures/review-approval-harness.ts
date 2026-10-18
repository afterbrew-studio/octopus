import "./review-outcome-stub";
import { mock } from "bun:test";
import assert from "node:assert/strict";
import type { AiCreateParams } from "@/lib/providers";
import type { ReviewCoverage } from "@/lib/review-coverage";

mock.module("server-only", () => ({}));

/**
 * What the real review pipeline decides to submit. The provider client is the
 * real OpenAI adapter over a fake transport, so request provenance, response
 * validation and completion are recorded by the real assessment code; only the
 * model's reply and the pull request's history are scripted.
 */

let reply = "";
// Which adapter carries the request: the OpenAI provider, the OpenAI-compatible gateway production
// uses, or an adapter that reports no completion evidence at all (as the local agent does).
let adapter: "openai" | "gateway" | "no-completion" = "openai";
let prior: ReviewCoverage | null = null;
let priorComments: { id: number; user: string; path: string; line: number; body: string; inReplyToId: null }[] = [];
const events: string[] = [];
const validationModels: string[] = [];
const archived: { coverage: ReviewCoverage }[] = [];
// Scripted replies consumed one per model call before `reply` applies; `error` fails the call.
let queue: { text: string; finish?: string; error?: boolean }[] = [];
const calls: { model: string; content: string }[] = [];
const usage: { model: string; operation: string }[] = [];

class FakeOpenAI {
  chat = { completions: { create: async (body: { model: string; messages: { role: string; content: string }[] }) => {
    calls.push({ model: body.model, content: body.messages.at(-1)?.content ?? "" });
    const next = queue.shift();
    if (next?.error) throw new Error("fixture provider failure");
    return { model: "gpt-fixture", choices: [{ finish_reason: next?.finish ?? "stop", message: { content: next?.text ?? reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
  } } };
}
mock.module("openai", () => ({ default: FakeOpenAI }));

const finding = {
  severity: "🟠", title: "Missing null check", filePath: "src/check.ts", startLine: 1, endLine: 1,
  category: "Bug", description: "A missing value causes this access to throw.", suggestion: "", confidence: 95,
};
const diff = "diff --git a/src/check.ts b/src/check.ts\n--- a/src/check.ts\n+++ b/src/check.ts\n@@ -1 +1 @@\n-return value;\n+return value.name;\n";
const org = { id: "org", defaultReviewConfig: {}, reviewLanguage: "en", approveWhenClean: true };
const repo = {
  id: "repo", fullName: "fixture/repo", organization: org, reviewConfig: {},
  provider: "github", installationId: 1, indexStatus: "indexed", defaultBranch: "main", organizationId: "org", autoReview: false,
};
const pr = {
  id: "pr", repository: repo, number: 1, title: "Handle missing values", author: "fixture",
  headSha: "a".repeat(40), reviewRequestVersion: 2, status: "pending", reviewBody: null as string | null, reviewCoverage: null,
  firstReviewCompletedAt: null as Date | null, claimToken: null as string | null,
};
const db = {
  reviewAttempt: { findFirst: async () => (prior ? { coverage: prior } : null) },
  repository: { findUnique: async () => repo, updateMany: async () => ({ count: 1 }), update: async () => repo },
  systemConfig: { findUnique: async () => null },
  reviewIssue: { findMany: async () => [] },
  pullRequest: {
    findUnique: async () => pr,
    updateMany: async ({ data }: { data: Record<string, unknown> }) => {
      if (typeof data.claimToken === "string") pr.claimToken = data.claimToken;
      return { count: 1 };
    },
  },
};
mock.module("@octopus/db", () => ({ prisma: { ...db, $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db) } }));
mock.module("@/lib/embeddings", () => ({ createEmbeddings: async (texts: string[]) => texts.map(() => [1, 0, 0]) }));
mock.module("@/lib/qdrant", () => ({
  searchSimilarChunks: async () => [], searchKnowledgeChunks: async () => [], searchReviewChunks: async () => [],
  searchFeedbackPatterns: async () => [], ensureFeedbackCollection: async () => {},
  ensureReviewCollection: async () => {}, upsertReviewChunks: async () => {}, deleteReviewChunksByPR: async () => {},
  ensureDiagramCollection: async () => {}, upsertDiagramChunk: async () => {}, deleteDiagramChunksByPR: async () => {},
  upsertFeedbackPattern: async () => {},
}));
mock.module("@/lib/reranker", () => ({ rerankDocuments: async () => [] }));
mock.module("@/lib/knowledge-context", () => ({ getAlwaysIncludeKnowledge: async () => [], mergeKnowledgeChunks: () => [] }));
let resolvedModel = "gpt-fixture";
let downshiftedFrom: string | null = null;
mock.module("@/lib/review-routing", () => ({ resolveReviewRoute: async () => ({ model: resolvedModel, downshiftedFrom }) }));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async (entry: { model: string; operation: string }) => { usage.push({ model: entry.model, operation: entry.operation }); } }));
mock.module("@/lib/ai-router", () => ({
  getProviderForModel: async () => { throw new Error("Legacy fixture must not resolve adaptive capacity"); },
  createAiMessage: async (params: AiCreateParams) => {
    if (adapter === "gateway") {
      const { callOpenAiGateway } = await import("@/lib/providers/openai-gateway");
      return callOpenAiGateway(params, { name: "opencode", modelPrefix: "opencode:", apiBase: "https://gateway.example.test/v1", apiKey: "fixture-key" });
    }
    const { openaiProvider } = await import("@/lib/providers/openai");
    const response = await openaiProvider.create(params, "fixture-key");
    if (adapter === "no-completion") return { ...response, completion: undefined };
    return response;
  },
}));
mock.module("@/lib/review-validation", () => ({
  gatherCrossFileContext: async () => "",
  gatherVerificationContext: async () => new Map(),
  validateFindings: async (findings: unknown[], _diff: string, _org: string, model: string) => { validationModels.push(model); return findings; },
}));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 123 }));
const realAttempt = await import("@/lib/review-attempt");
mock.module("@/lib/review-attempt", () => ({
  ...realAttempt,
  withForgejoReviewPublication: async (_id: string, _head: string, _version: number, publish: () => Promise<void>) => publish(),
  createReviewAttemptComment: async (_id: string, _head: string, _version: number, create: () => Promise<number>) => create(),
  updateCurrentReview: async () => ({ count: 1 }),
  saveReviewAttempt: async (_id: string, _pr: string, coverage: ReviewCoverage) => { archived.push({ coverage: structuredClone(coverage) }); return false; },
}));
mock.module("@/lib/github", () => ({
  LargePrError: class LargePrError extends Error {},
  getPullRequestReviewInput: async () => ({ rawDiff: diff, input: {
    provider: "github", headSha: pr.headSha, baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: 1, limitations: [],
    files: [{ path: "src/check.ts", change: "modified", patch: "@@ -1 +1 @@\n-return value;\n+return value.name;\n", additions: 1, deletions: 1 }],
  } }),
  // Long enough to state a purpose, which the approval's change-shape check requires.
  getPullRequestDetails: async () => ({ body: "Handle a missing value in the check so that callers no longer throw on it." }),
  createPullRequestComment: async () => 123,
  updatePullRequestComment: async () => {},
  createPullRequestReview: async (_i: number, _o: string, _r: string, _n: number, _body: string, event: string) => { events.push(event); return 456; },
  createCheckRun: async () => 789,
  updateCheckRun: async () => {},
  getRepositoryTree: async () => ["src/check.ts"],
  getFileContent: async () => "return value.name;",
  listReviewComments: async () => [],
  listPullRequestReviewComments: async () => priorComments,
  listPullRequestIssueComments: async () => [],
  listPullRequestReviews: async () => [],
  getCommentReactions: async () => ({ thumbsUp: 0, thumbsDown: 0 }),
  listOwnUnresolvedThreads: async () => [],
  resolveReviewThread: async () => {},
  createSingleReviewComment: async () => 999,
  checkReportFor: async () => ({ state: "passing", failing: [] }),
}));
mock.module("@/lib/forgejo", () => ({ runWithForgejoRepository: async (_repo: string, run: () => Promise<void>) => run(), usesForgejoConnector: () => false }));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ slug: "fixture" }) }));
mock.module("@/lib/queue", () => ({
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 60, largeReviewTimeoutSeconds: 60 }),
  computeStaleReclaimMs: () => 120000, enqueue: async () => {}, enqueueAfter: async () => "job",
}));
mock.module("@/lib/cost", () => ({ getOrgSpendLimitStatus: async () => ({ blocked: false }), shouldGuardConcurrency: async () => false }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/indexer", () => ({ indexRepository: async () => { throw new Error("unexpected indexing"); } }));
mock.module("@/lib/review-repository-preparation", () => ({
  ensureRepositoryAnalysis: async () => "ready", deferReviewForRepository: async () => true,
}));
mock.module("@/lib/elasticsearch", () => ({ writeSyncLog: () => {}, deleteSyncLogs: async () => {} }));
mock.module("@/lib/repo-config", () => ({
  fetchRepoConfigFile: async () => null, extractRepoConfigRules: async () => null,
  buildRepoConfigUserBlock: () => "", normalizeRepoConfigFiles: () => [],
}));

const report = (findings: unknown[]) => `## 🐙 Octopus Review
### Summary
The changed access needs a null check.
### Score
| Category | Score | Notes |
| --- | --- | --- |
| Security | 5/5 | No finding |
| Code Quality | 5/5 | Clean |
| Performance | 5/5 | Bounded |
| Error Handling | 5/5 | Clean |
| Consistency | 5/5 | Consistent |
| **Overall** | **5/5** | Clean |
### Findings Summary
| Severity | Count |
| --- | --- |
${findings.length ? `| 🟠 High | ${findings.length} |\n` : ""}### Findings
<!-- OCTOPUS_FINDINGS_START -->
${JSON.stringify(findings)}
<!-- OCTOPUS_FINDINGS_END -->`;
const { processReview } = await import("@/lib/reviewer");

async function submittedEvent(text: string): Promise<string | undefined> {
  reply = text;
  events.length = 0;
  pr.status = "pending";
  await processReview("pr");
  return events[0];
}

// Control: a clean, well-formed, fully supplied review is approved.
assert.equal(await submittedEvent(report([])), "APPROVE", "a clean, complete review of a small diff must still approve");
const recorded = archived.at(-1)!.coverage;
assert.equal(recorded.assessment?.state, "completed");

// The path production reviews take: the OpenAI-compatible gateway reports finish_reason, which is
// the completion evidence approval needs. A clean, fully covered review through it still approves.
adapter = "gateway";
assert.equal(await submittedEvent(report([])), "APPROVE", "a clean review through the gateway adapter must still approve");
assert.equal(archived.at(-1)!.coverage.assessment?.completion?.state, "completed");

// An adapter that reports no completion evidence cannot approve: absence is not completion.
adapter = "no-completion";
assert.equal(await submittedEvent(report([])), "COMMENT", "an adapter without completion evidence must stay fail-safe");
adapter = "openai";

// Prose that is not the review format yields zero findings; that is unknown, not clean.
assert.equal(await submittedEvent("Overall 5/5"), "COMMENT", "a malformed reply must not approve");
assert.equal(archived.at(-1)!.coverage.assessment?.state, "incomplete");

// A re-review that finds the same unresolved HIGH at the same line must not approve the new head.
prior = { ...structuredClone(recorded), reviewRequestVersion: 1 };
priorComments = [{ id: 5, user: "fixture[bot]", path: "src/check.ts", line: 1, inReplyToId: null,
  body: `🟠 ${finding.title}\n\n${finding.description}` }];
assert.equal(await submittedEvent(report([finding])), "COMMENT", "a repeated unresolved HIGH must not approve the new head");

// The validation pass is handed the model this review resolved, not one of its own.
resolvedModel = "opencode:glm-5.3";
validationModels.length = 0;
await submittedEvent(report([finding]));
assert.deepEqual(validationModels, ["opencode:glm-5.3"], "validation must run on the review's resolved model");
resolvedModel = "gpt-fixture";

// A response the format validator rejects is regenerated once, on the model the review would have
// used without a downshift, and only the accepted attempt is verified and posted.
const malformed = "## 🐙 Octopus Review\n### Summary\nLooks fine.";
const rejectionReason = "Review headings missing or duplicated";
const logged: string[] = [];
const log = console.log;
console.log = (...parts: unknown[]) => { logged.push(parts.join(" ")); };
async function run(script: typeof queue) {
  queue = script; calls.length = 0; usage.length = 0; logged.length = 0;
  const event = await submittedEvent(report([]));
  queue = [];
  return { event, retryLines: logged.filter(line => line.includes("Review format retry")) };
}
prior = null; priorComments = [];

const single = await run([]);
assert.equal(single.event, "APPROVE");
assert.equal(calls.length, 1, "a valid first response makes exactly one call");
assert.deepEqual(usage.map(u => u.model), ["gpt-fixture"]);
assert.equal(single.retryLines.length, 0);

const recovered = await run([{ text: malformed }, { text: report([]) }]);
assert.equal(recovered.event, "APPROVE", "a format-rejected response followed by a valid one is verified");
assert.equal(calls.length, 2, "exactly one retry");
assert.equal(archived.at(-1)!.coverage.assessment?.state, "completed");
assert.equal(archived.at(-1)!.coverage.assessment?.requests.length, 1, "the stored assessment is the accepted attempt's");
assert.ok(calls[1].content.startsWith(calls[0].content), "the retry resends the original request");
assert.ok(calls[1].content.includes(`rejected by the review format validator: ${rejectionReason}`), "the retry names the rejection reason");
assert.deepEqual(usage.map(u => [u.model, u.operation]), [["gpt-fixture", "review"], ["gpt-fixture", "review"]], "each attempt is metered");
assert.equal(recovered.retryLines.length, 1);
assert.ok(recovered.retryLines[0].includes(`reason="${rejectionReason}"`) && recovered.retryLines[0].includes("from=gpt-fixture to=gpt-fixture"));

resolvedModel = "acp:mechanical"; downshiftedFrom = "opencode:pinned";
const downshifted = await run([{ text: malformed }, { text: report([]) }]);
assert.equal(downshifted.event, "APPROVE");
assert.deepEqual(calls.map(c => c.model), ["acp:mechanical", "opencode:pinned"], "a downshifted review retries on the pinned model");
assert.deepEqual(usage.map(u => u.model), ["acp:mechanical", "opencode:pinned"], "each attempt is metered against the model that ran");
assert.ok(downshifted.retryLines[0].includes("from=acp:mechanical to=opencode:pinned"));
const downshiftedValid = await run([]);
assert.equal(downshiftedValid.event, "APPROVE");
assert.deepEqual(calls.map(c => c.model), ["acp:mechanical"], "a valid downshifted response is not retried");
resolvedModel = "gpt-fixture"; downshiftedFrom = null;

const bothRejected = await run([{ text: malformed }, { text: malformed }]);
assert.equal(bothRejected.event, "COMMENT", "a response rejected twice is never verified");
assert.equal(calls.length, 2, "exactly one retry, never a second");
assert.equal(archived.at(-1)!.coverage.assessment?.state, "incomplete");
assert.equal(archived.at(-1)!.coverage.assessment?.responseValidation?.state, "invalid");

const providerError = await run([{ text: "", error: true }]);
assert.equal(providerError.event, undefined, "a provider failure submits no review");
assert.equal(calls.length, 1, "a provider failure is not retried by the format path");

const truncated = await run([{ text: malformed, finish: "length" }]);
assert.equal(truncated.event, "COMMENT");
assert.equal(calls.length, 1, "a truncated response is not retried");
console.log = log;

console.log("PASS ordinary review approval requires a verified, finding-free review");
