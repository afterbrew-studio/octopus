import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * Non-Forgejo admission commits its pull-request write immediately, with no
 * ambient transaction -- unlike Forgejo, which always runs inside one. If
 * `freezeReviewRun` then throws (a config read failing, say), the admission
 * had already committed: the pull request is stranded `pending` with no run
 * and no job, a retry is refused as already-in-progress, and nothing
 * non-terminal exists for the pending-row reaper to recover.
 *
 * `startReviewFlowInternal` now wraps admission and freeze in the SAME
 * transaction for every provider, so a freeze failure rolls the admission
 * back too and a retry starts clean, exactly as if the first request never
 * happened.
 *
 * The mock `$transaction` below stages writes separately and only merges them
 * into the "committed" store when its callback resolves -- a real rollback,
 * not a simplified stand-in, so a bug in the transaction boundary itself
 * would show up here.
 */

mock.module("server-only", () => ({}));

const A = "a".repeat(40);
type Row = Record<string, unknown> & { id: string; status: string; headSha: string | null; reviewRequestVersion: number };
type Run = { id: string; headSha: string | null; reviewRequestVersion: number | null };

let committedPr: Row | null = null;
const committedRuns: Run[] = [];
let freezeShouldFail = false;
let nextRunId = 0;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function makeClient(prHolder: { current: Row | null }, runs: Run[]) {
  return {
    organization: { findUnique: async () => ({ reviewsPaused: false, blockedAuthors: [], defaultReviewConfig: null }) },
    systemConfig: { findUnique: async () => ({ blockedAuthors: [], defaultReviewConfig: null }) },
    repository: { findUnique: async () => ({ reviewConfig: null }) },
    reviewAttempt: { findFirst: async () => null },
    pullRequest: {
      findUnique: async () => (prHolder.current ? { ...prHolder.current } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        prHolder.current = { ...data, id: "pr-1", reviewRequestVersion: 1, createdAt: new Date() } as Row;
        return { ...prHolder.current };
      },
      updateManyAndReturn: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!prHolder.current || !matches(prHolder.current, where)) return [];
        prHolder.current = { ...prHolder.current, ...data } as Row;
        return [{ ...prHolder.current }];
      },
    },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: { headSha: string | null; reviewRequestVersion: number | null } }) => {
        if (freezeShouldFail) throw new Error("Config read unavailable");
        const run: Run = { id: `run-${nextRunId++}`, headSha: data.headSha, reviewRequestVersion: data.reviewRequestVersion };
        runs.push(run);
        return { id: run.id };
      },
    },
  };
}

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    ...makeClient({ get current() { return committedPr; }, set current(v: Row | null) { committedPr = v; } }, committedRuns),
    $transaction: async (callback: (tx: ReturnType<typeof makeClient>) => Promise<unknown>) => {
      const staged = { current: committedPr ? { ...committedPr } : null };
      const stagedRuns = [...committedRuns];
      const result = await callback(makeClient(staged, stagedRuns));
      // Commit only on a resolved callback -- a throw leaves `committedPr`/
      // `committedRuns` exactly as they were, proving the rollback.
      committedPr = staged.current;
      committedRuns.length = 0;
      committedRuns.push(...stagedRuns);
      return result;
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

// 1. Freeze throws: nothing is committed -- no pull request row, no run.
freezeShouldFail = true;
await assert.rejects(() => startReviewFlow(params), /Config read unavailable/);
assert.equal(committedPr, null, "a rolled-back admission must leave no pull request row behind");
assert.equal(committedRuns.length, 0, "a rolled-back freeze must leave no run behind");
assert.equal(enqueued, 0);

// 2. Retry admits cleanly, as if the first request never happened.
freezeShouldFail = false;
const result = await startReviewFlow(params);
assert.equal(result.started, true);
assert.ok(committedPr, "the retry must actually create the pull request");
assert.equal(committedRuns.length, 1, "the retry must freeze exactly one run");
assert.equal(enqueued, 1);

console.log("PASS a freeze failure rolls back its admission; the retry admits cleanly");
