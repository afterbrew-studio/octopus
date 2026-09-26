import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * Non-Forgejo admission commits its pull-request write immediately, with no
 * ambient transaction -- unlike Forgejo, which always runs inside one.
 * Wrapping every provider's admission in its own transaction (a prior pass)
 * broke two things admission itself relies on: its provider API call held
 * that transaction open for as long as the provider took to respond, and its
 * concurrent-create P2002 recovery re-queried on the SAME transaction, which
 * PostgreSQL had already aborted after that error.
 *
 * So admission commits on its own again, and a `freezeReviewRun` failure
 * instead reverts it: a compensating write, guarded on the exact identity
 * admission just produced, returns the pull request to a retryable "failed"
 * status (not the "pending" that would refuse a retry as already-in-progress)
 * and rethrows so the provider retries into a clean state.
 */

mock.module("server-only", () => ({}));

const A = "a".repeat(40);
type Row = Record<string, unknown> & { id: string; status: string; headSha: string | null; reviewRequestVersion: number };
type Run = { id: string; headSha: string | null; reviewRequestVersion: number | null };

let current: Row | null = null;
const runsCreated: Run[] = [];
let freezeShouldFail = false;
let nextRunId = 0;

function matches(where: Record<string, unknown>): boolean {
  if (!current) return false;
  return Object.entries(where).every(([key, value]) => current![key] === value);
}
function apply(data: Record<string, unknown>) {
  assert.ok(current);
  const increment = data.reviewRequestVersion as { increment: number } | undefined;
  const version = increment ? current.reviewRequestVersion + increment.increment : current.reviewRequestVersion;
  current = { ...current, ...structuredClone(data), reviewRequestVersion: version };
}

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
      updateManyAndReturn: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return [];
        apply(data);
        return [{ ...current }];
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        apply(data);
        return { count: 1 };
      },
    },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: { headSha: string | null; reviewRequestVersion: number | null } }) => {
        if (freezeShouldFail) throw new Error("Config read unavailable");
        const run: Run = { id: `run-${nextRunId++}`, headSha: data.headSha, reviewRequestVersion: data.reviewRequestVersion };
        runsCreated.push(run);
        return { id: run.id };
      },
    },
  },
}));
mock.module("@/lib/github", () => ({
  getPullRequestDetails: async () => ({ number: 1, title: "Title", author: "author", url: "https://example.test/pr/1", headSha: A }),
  createPullRequestComment: async () => 1,
}));
mock.module("@/lib/bitbucket", () => ({}));
mock.module("@/lib/gitlab", () => ({}));
mock.module("@/lib/forgejo", () => ({ runWithForgejoRepository: async (_id: string, run: () => Promise<unknown>) => run() }));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 123 }));
let enqueued = 0;
mock.module("@/lib/queue", () => ({
  enqueue: async () => { enqueued++; return "job-1"; },
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const { startReviewFlow } = await import("../../webhook-shared");
const params = {
  // "adapter": simulates an authenticated dispatcher; a raw provider
  // "webhook" is refused outright by this deployment's policy. See
  // review-start-policy.ts.
  source: "adapter" as const,
  provider: "github" as const,
  installationId: 123,
  repoFullName: "owner/repo",
  repoId: "repo",
  orgId: "org",
  prNumber: 1,
  prTitle: "Title",
  prUrl: "https://example.test/pr/1",
  prAuthor: "author",
  headSha: A as string | null,
  triggerCommentId: 1,
  triggerCommentBody: "Review",
};

// 1. Freeze throws: admission already committed (there is no transaction to
// roll it back), so the failure must revert it itself -- to "failed", the
// one status admission's own already-in-progress check does not block on --
// not leave the row stranded "pending" with no run and no job.
freezeShouldFail = true;
await assert.rejects(() => startReviewFlow(params), /Config read unavailable/);
assert.ok(current, "admission's own commit is real and is not expected to vanish");
assert.equal(current!.status, "failed", "a freeze failure must revert admission to a retryable status, not leave it stranded pending");
assert.equal(runsCreated.length, 0, "a failed freeze must leave no run behind");
assert.equal(enqueued, 0);

// 2. Retry admits cleanly: "failed" is not in admission's already-in-progress
// set, so the SAME pull request is reclaimed rather than refused.
freezeShouldFail = false;
const result = await startReviewFlow(params);
assert.equal(result.started, true);
assert.equal(current!.status, "pending", "the retry must actually be admitted and enqueued, not refused as already in progress");
assert.equal(runsCreated.length, 1, "the retry must freeze exactly one run");
assert.equal(enqueued, 1);

console.log("PASS a freeze failure reverts its admission to a retryable status; the retry admits cleanly");
