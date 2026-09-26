import { mock } from "bun:test";
import assert from "node:assert/strict";

/**
 * The run is created as part of admission's OWN atomic write -- a short
 * transaction admission opens itself around the pull request's create/update
 * and the run addressing it -- not a separate step after admission returns.
 * Compensating for a separate failure cannot close the crash window between
 * two writes; only one write can.
 *
 * The mock `$transaction` below stages writes separately and only merges them
 * into the "committed" store when its callback resolves -- a real rollback,
 * not a simplified stand-in -- so a bug in the transaction boundary itself
 * would show up here, and the pull request's own P2002 concurrent-create
 * recovery is exercised for real (not assumed), reading back against the
 * SAME plain client the retry uses rather than an aborted transaction.
 */

mock.module("server-only", () => ({}));

const A = "a".repeat(40);
type Row = Record<string, unknown> & { id: string; status: string; headSha: string | null; reviewRequestVersion: number };
type Run = { id: string; headSha: string | null; reviewRequestVersion: number | null };

let committedPr: Row | null = null;
const committedRuns: Run[] = [];
let createRunShouldFail = false;
let nextRunId = 0;
let duringHeadRead: (() => Promise<void>) | undefined;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}
function makeClient(prHolder: { current: Row | null }, runs: Run[]) {
  return {
    organization: { findUnique: async () => ({ reviewsPaused: false, blockedAuthors: [], defaultReviewConfig: null }) },
    systemConfig: { findUnique: async () => ({ blockedAuthors: [], defaultReviewConfig: null }) },
    repository: { findUnique: async () => ({ reviewConfig: null }) },
    reviewAttempt: { findFirst: async () => null },
    pullRequest: {
      findUnique: async () => (prHolder.current ? { ...prHolder.current, attempts: [] } : null),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // The unique (repositoryId, number) constraint a concurrent create
        // would violate -- the same identity is being admitted twice.
        if (prHolder.current) throw Object.assign(new Error("unique repository/PR"), { code: "P2002" });
        prHolder.current = { ...data, createdAt: new Date(), updatedAt: new Date() } as Row;
        return { ...prHolder.current };
      },
      updateManyAndReturn: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!prHolder.current || !matches(prHolder.current, where)) return [];
        const increment = data.reviewRequestVersion as { increment: number } | undefined;
        const reviewRequestVersion = increment ? prHolder.current.reviewRequestVersion + increment.increment : prHolder.current.reviewRequestVersion;
        prHolder.current = { ...prHolder.current, ...data, reviewRequestVersion, updatedAt: new Date() } as Row;
        return [{ ...prHolder.current }];
      },
    },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: { headSha: string | null; reviewRequestVersion: number | null } }) => {
        if (createRunShouldFail) throw new Error("Config read unavailable");
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
    // Stages writes on a private copy and only merges them into the
    // "committed" store on a resolved callback -- a genuine rollback on
    // throw, exercising the SAME transaction boundary the real code relies
    // on rather than assuming it.
    $transaction: async (callback: (tx: ReturnType<typeof makeClient>) => Promise<unknown>) => {
      const staged = { current: committedPr ? { ...committedPr } : null };
      const stagedRuns = [...committedRuns];
      const result = await callback(makeClient(staged, stagedRuns));
      committedPr = staged.current;
      committedRuns.length = 0;
      committedRuns.push(...stagedRuns);
      return result;
    },
  },
}));
mock.module("@/lib/github", () => ({
  getPullRequestDetails: async () => {
    const callback = duringHeadRead; duringHeadRead = undefined;
    await callback?.();
    return { number: 1, title: "Title", author: "author", url: "https://example.test/pr/1", headSha: A };
  },
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

// 1. The run fails to create: the pull request's own create must roll back
// with it, in the SAME atomic write -- not a pending row with no run for
// nothing to ever recover.
createRunShouldFail = true;
await assert.rejects(() => startReviewFlow(params), /Config read unavailable/);
assert.equal(committedPr, null, "a failed run creation must roll back the pull request write too, not leave it pending with no run");
assert.equal(committedRuns.length, 0);
assert.equal(enqueued, 0);
createRunShouldFail = false;

// 2. Retry admits cleanly: nothing was left behind by (1) to refuse it.
const result = await startReviewFlow(params);
assert.equal(result.started, true);
assert.ok(committedPr);
assert.equal(committedRuns.length, 1);
assert.equal(enqueued, 1);

// 3. A concurrent duplicate admission: a second request for the SAME pull
// request is admitted by another server between this one's own read and its
// create. Its create() hits the real unique-constraint conflict (P2002) the
// mock models above, and the retry read that follows must run against a
// PLAIN, healthy client -- not one left aborted by a transaction the failed
// create was part of -- and resolve to already_in_progress rather than a
// transaction failure.
committedPr = null;
committedRuns.length = 0;
let concurrentAdmissionRan = false;
duringHeadRead = async () => {
  concurrentAdmissionRan = true;
  const concurrent = await startReviewFlow(params);
  assert.equal(concurrent.started, true, "the concurrent admission itself must succeed");
};
const raced = await startReviewFlow(params);
assert.ok(concurrentAdmissionRan);
assert.equal(raced.started, false);
if (!raced.started) assert.equal(raced.reason, "already_in_progress", "a concurrent create conflict must resolve to already_in_progress, not surface as a transaction failure");
assert.equal(committedRuns.length, 1, "only the concurrent admission's own run may exist");

console.log("PASS the run is created atomically with admission; a failure rolls back the pull request too, and a concurrent create conflict resolves to already_in_progress");
