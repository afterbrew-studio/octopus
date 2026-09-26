import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * Every CLI-started review must leave an attempt behind.
 *
 * The route had two paths: an unknown pull request went through
 * `startReviewFlow`, and a known one called `processReview` directly -- skipping
 * the attempt record, so the review ran on live configuration and left nothing
 * attributable. rayf#122.
 *
 * These let the REAL `startReviewFlow` (and the admission it delegates to) run
 * and assert the row it writes, rather than mocking it and asserting it was
 * called. Mocking it would prove the route calls a function; the property is
 * that an attempt exists. Run as a spawned subprocess (not in-process): bun's
 * module mocks are process-wide, and this file's `@/lib/api-auth` stub must
 * not leak into another file in the same run that wants the real
 * `authenticateApiToken` (account-standing.test.ts).
 */

const created: Array<Record<string, unknown>> = [];
const enqueued: Array<Record<string, unknown>> = [];
type PrRow = { id: string; status: string; headSha?: string; reviewRequestVersion?: number; updatedAt?: Date; createdAt?: Date; reviewCommentId?: number | null };
let prRow: PrRow | null = null;

function matches(where: Record<string, unknown>): boolean {
  if (!prRow) return false;
  return Object.entries(where).every(([key, value]) => value instanceof Date
    ? prRow![key as keyof PrRow] instanceof Date && (prRow![key as keyof PrRow] as Date).getTime() === value.getTime()
    : prRow![key as keyof PrRow] === value);
}

mock.module("@octopus/db", () => ({
  Prisma: { DbNull: null },
  prisma: {
    repository: {
      findFirst: async () => ({
        id: "repo_1",
        fullName: "afterbrew-studio/rayf",
        provider: "github",
        installationId: 1,
        isActive: true,
      }),
      findUnique: async () => ({ reviewConfig: null }),
    },
    pullRequest: {
      findUnique: async () => prRow,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        prRow = { id: "pr_1", status: "pending", reviewRequestVersion: 1, updatedAt: new Date(), createdAt: new Date(), ...data } as PrRow;
        return prRow;
      },
      updateManyAndReturn: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return [];
        prRow = { ...prRow, ...data, updatedAt: new Date() } as PrRow;
        return [prRow];
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where)) return { count: 0 };
        prRow = { ...prRow, ...data } as PrRow;
        return { count: 1 };
      },
    },
    reviewRun: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "att_1" };
      },
    },
    systemConfig: { findUnique: async () => null },
    organization: { findUnique: async () => ({ defaultReviewConfig: null }) },
  },
}));
mock.module("@/lib/api-auth", () => ({
  authenticateApiToken: async () => ({ org: { id: "org_1" } }),
}));
mock.module("@/lib/queue", () => ({
  enqueue: async (_name: string, data: Record<string, unknown>) => {
    enqueued.push(data);
    return "job";
  },
  loadQueueConfig: async () => ({ reviewTimeoutSeconds: 900, reviewConcurrency: 2, largeReviewTimeoutSeconds: 1800 }),
  computeStaleReclaimMs: (s: number) => (s + 300) * 1000,
}));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/github", () => ({
  getPullRequestDetails: async () => ({
    number: 134,
    title: "t",
    url: "u",
    author: "a",
    headSha: "fresh-sha",
  }),
  createPullRequestComment: async () => 1,
  updatePullRequestComment: async () => {},
  createCheckRun: async () => 1,
  updateCheckRun: async () => {},
}));
mock.module("@/lib/gitlab", () => ({ getPullRequestDetails: async () => ({}) }));
mock.module("@/lib/bitbucket", () => ({ getPullRequestDetails: async () => ({}), listWorkspaceRepos: async () => [] }));
mock.module("@/lib/forgejo", () => ({
  getPullRequestDetails: async () => ({}),
  runWithForgejoRepository: async (_id: string, run: () => Promise<unknown>) => run(),
}));
// The durable, transactional placeholder-comment publisher is not under test
// here; the property under test is that an attempt row is written.
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 1 }));

const { POST } = await import("../../../app/api/cli/repos/[id]/review/route");

const post = (body: unknown) =>
  POST(
    new Request("http://x/api/cli/repos/repo_1/review", {
      method: "POST",
      headers: { authorization: "Bearer oct_x", "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id: "repo_1" }) },
  );

// for a pull request it has never seen
created.length = 0; enqueued.length = 0;
prRow = null;
await post({ prNumber: 134 });
assert.equal(created.length, 1);
assert.equal(created[0]!.source, "adapter");

// for one it already knows -- the regression: this path called processReview
// directly and created none.
created.length = 0; enqueued.length = 0;
prRow = { id: "pr_1", status: "completed", headSha: "fresh-sha", reviewRequestVersion: 1, updatedAt: new Date(), createdAt: new Date() };
await post({ prNumber: 134 });
assert.equal(created.length, 1);
assert.equal(created[0]!.source, "adapter");

// and the job carries that run
created.length = 0; enqueued.length = 0;
prRow = { id: "pr_1", status: "completed", headSha: "fresh-sha", reviewRequestVersion: 1, updatedAt: new Date(), createdAt: new Date() };
await post({ prNumber: 134 });
assert.equal(enqueued[0]?.reviewRunId, "att_1");

// recording the head SHA it re-read, not the stored one
created.length = 0; enqueued.length = 0;
prRow = { id: "pr_1", status: "completed", headSha: "stale-sha", reviewRequestVersion: 1, updatedAt: new Date(), createdAt: new Date() };
await post({ prNumber: 134 });
assert.equal(created[0]!.headSha, "fresh-sha");

// carrying a caller-supplied correlation id when one is given
created.length = 0; enqueued.length = 0;
prRow = null;
await post({ prNumber: 134, correlationId: "req-42" });
assert.equal(created[0]!.correlationId, "req-42");

// and refusing outright while one is already running -- same head as the
// freshly re-read one, and recent: a genuinely live review.
created.length = 0; enqueued.length = 0;
prRow = { id: "pr_1", status: "reviewing", headSha: "fresh-sha", reviewRequestVersion: 1, updatedAt: new Date(), createdAt: new Date() };
const res = await post({ prNumber: 134 });
assert.equal(res.status, 409);
assert.equal(created.length, 0);

console.log("PASS CLI review route attempt creation");
