import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * The large-review result path decides APPROVE on its own, so it has to reach
 * the same answer as the ordinary path's `mayApprove`. Persistence and delivery
 * are stubbed; what is asserted is the review event handed to GitHub.
 */

const head = "a".repeat(40), base = "c".repeat(40);
// The current request, which a newer admission replaces.
const row = { headSha: head, reviewRequestVersion: 1, reviewBody: "" };
const admitNewRequest = () => Object.assign(row, { headSha: "b".repeat(40), reviewRequestVersion: 2, reviewBody: "" });
let admitAfterReads: number | null = null;
let archivedReads = 0;
const run: { publication: Record<string, unknown> | null } = { publication: null };
let org = { id: "org", approveWhenClean: true, checkFailureThreshold: "critical", defaultReviewConfig: null };
const db = {
  pullRequest: {
    findUnique: async () => {
      const current = {
        id: "pr", number: 7, title: "Large change", url: "https://example.test/pr/7",
        headSha: row.headSha, reviewRequestVersion: row.reviewRequestVersion, reviewBody: row.reviewBody,
        repository: { id: "repo", provider: "github", fullName: "owner/repo", installationId: 1, reviewConfig: null, organization: org },
      };
      // A request admitted right after the Nth read of the row, once this one is archived.
      if (admitAfterReads !== null && archivedReads++ === admitAfterReads) admitNewRequest();
      return current;
    },
  },
  systemConfig: { findUnique: async () => null },
  reviewIssue: { findMany: async () => [] },
  // One run, whose `publication` is what the verdict machinery persists.
  reviewRun: {
    findUnique: async ({ select }: { select?: { publication?: boolean } }) => (select?.publication ? { publication: run.publication } : { id: "run-1", configSnapshot: {} }),
    findFirst: async () => ({ id: "run-1", configSnapshot: {} }),
    findMany: async () => (run.publication && (run.publication as { state: string }).state === "pending" ? [{ id: "run-1", publication: run.publication }] : []),
    updateMany: async ({ data }: { data: { publication?: unknown; state?: string } }) => {
      if (data.publication !== undefined) run.publication = structuredClone(data.publication);
      return { count: 1 };
    },
  },
};
mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma: db }));

const realAttempt = await import("../../review-attempt");
mock.module("@/lib/review-attempt", () => ({
  ...realAttempt,
  hasReviewAttempt: async () => {},
  saveReviewAttempt: async (_id: string, _pr: string, _coverage: unknown, reviewBody: string) => { row.reviewBody = reviewBody; await afterSave?.(); return true; },
  // Applies the guard the real write carries, against the current request.
  updateCurrentReview: async (_pr: string, headSha: string, version: number, _data: unknown, expectedBody?: string) =>
    ({ count: row.headSha === headSha && row.reviewRequestVersion === version && (expectedBody === undefined || row.reviewBody === expectedBody) ? 1 : 0 }),
  recordFirstReviewCompletion: async () => {},
}));
mock.module("@/lib/review-attempt-delivery", () => ({
  deliverReviewAttempt: async (_id: string, deliver: (p: unknown, c: () => Promise<void>) => Promise<void>) =>
    deliver({ mainCommentId: null, summaryPublished: false }, async (data: Record<string, unknown>) => { checkpoints.push(data); }),
}));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async (target: { body: string }) => { summaries.push(target.body); return 1; } }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const events: string[] = [];
const dismissals: number[] = [];
const jobs: { name: string; data: Record<string, unknown>; delay: number; options?: unknown }[] = [];
const summaries: string[] = [];
const checkpoints: Record<string, unknown>[] = [];
let recordedAtPost: Record<string, unknown> | null = null;
let afterSave: (() => void) | null = null;
let duringPost: (() => void) | null = null;
let postOutcome: "accept" | "ambiguous" = "accept";
// The reviews GitHub would list for the pull request.
let listedReviews: { id: number; user: string; state: string; commitId: string | null; submittedAt: string | null }[] = [];
let dismissFailure = false;
const { AmbiguousPublicationError } = await import("../../review-publication");
mock.module("@/lib/github", () => ({
  createPullRequestReview: async (...args: unknown[]) => {
    events.push(String(args[5]));
    recordedAtPost = structuredClone(run.publication);
    duringPost?.();
    if (postOutcome === "ambiguous") throw new AmbiguousPublicationError("gateway timeout");
    return 901;
  },
  listPullRequestReviewsStrict: async () => listedReviews,
  dismissPullRequestReview: async (_i: number, _o: string, _r: string, _n: number, reviewId: number) => {
    if (dismissFailure) throw new Error("GitHub unavailable");
    dismissals.push(reviewId);
  },
  updateCheckRun: async () => {},
}));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ slug: "octopus-review" }) }));
mock.module("@/lib/queue", () => ({
  enqueueAfter: async (name: string, data: Record<string, unknown>, delay: number, options?: unknown) => { jobs.push({ name, data, delay, options }); return "job"; },
}));

const { handleLargeReviewResult } = await import("../../large-review-result");
const { reconcileReviewPublication, requeueUnresolvedPublications } = await import("../../review-publication-reconcile");

const job = (reviewBody: string, n: number) => ({
  pullRequestId: "pr", attemptId: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, headSha: head, baseSha: base,
  reviewRequestVersion: 1, reviewBody,
});
async function eventFor(reviewBody: string, n: number): Promise<string | undefined> {
  events.length = 0;
  dismissals.length = 0;
  Object.assign(row, { headSha: head, reviewRequestVersion: 1, reviewBody: "" });
  Object.assign(run, { publication: null });
  jobs.length = 0; summaries.length = 0; checkpoints.length = 0; recordedAtPost = null; postOutcome = "accept";
  // The handler only publishes while the stored row still carries the body it archived.
  await handleLargeReviewResult(job(reviewBody, n));
  return events[0];
}

const completeClean = "Overall 5/5\n<!-- OCTOPUS_FINDINGS_START -->\n[]\n<!-- OCTOPUS_FINDINGS_END -->";
const truncated = "Overall 5/5\n<!-- OCTOPUS_FINDINGS_START -->\n[{\"severity\":\"🔴\",\"title\":\"Auth bypass\",\"fil";

assert.equal(await eventFor(truncated, 1), "COMMENT", "a response cut off inside its findings block must not approve");
assert.equal(await eventFor(completeClean, 2), "COMMENT", "unknown changed-file coverage must not approve, even for a well-formed clean block");
assert.equal(await eventFor("", 3), "COMMENT", "an empty response must not approve");

org = { ...org, approveWhenClean: false };
assert.equal(await eventFor(completeClean, 4), "COMMENT");
org = { ...org, approveWhenClean: true };

const critical = `<!-- OCTOPUS_FINDINGS_START -->\n[{"severity":"🔴","title":"Auth bypass","filePath":"a.ts","startLine":1,"endLine":1,"category":"security","description":"d","confidence":95}]\n<!-- OCTOPUS_FINDINGS_END -->`;
assert.equal(await eventFor(critical, 5), "REQUEST_CHANGES", "a blocking finding still requests changes");

// A verdict with standing is recorded durably before it is sent, together with the
// job that settles it; a comment holds nothing in force and needs neither.
assert.equal(await eventFor(critical, 6), "REQUEST_CHANGES");
assert.equal(jobs.length, 1, "a blocking verdict schedules its reconcile");
assert.equal((recordedAtPost as { event?: string } | null)?.event, "REQUEST_CHANGES", "the record exists before the provider call");
assert.deepEqual({ ...jobs[0].data, sentAt: undefined }, { ...(recordedAtPost as object), sentAt: undefined });
assert.equal(jobs[0].delay >= 60, true, "the reconcile waits out any request still in flight");
assert.equal(await eventFor(completeClean, 7), "COMMENT");
assert.equal(jobs.length, 0, "a comment is not reconciled");

// A request admitted while the POST is in flight. Nothing is withdrawn inline: the
// reconcile finds the verdict and dismisses it, because its request was replaced.
const settleAfter = async (reviews: typeof listedReviews) => {
  listedReviews = reviews;
  await reconcileReviewPublication(jobs[0].data as never);
};
const standing = (overrides: Partial<(typeof listedReviews)[number]> = {}) => ({
  id: 901, user: "octopus-review[bot]", state: "CHANGES_REQUESTED", commitId: head, submittedAt: new Date(Date.now() + 1000).toISOString(), ...overrides,
});
duringPost = admitNewRequest;
assert.equal(await eventFor(critical, 8), "REQUEST_CHANGES");
duringPost = null;
assert.deepEqual(dismissals, [], "no inline dismissal: the reconcile owns it");
await settleAfter([standing()]);
assert.deepEqual(dismissals, [901], "a blocking review published for a request that was replaced meanwhile must be withdrawn");
assert.equal((run.publication as { state: string }).state, "dismissed");

// A dismissal that fails is retried, not recorded as done.
duringPost = admitNewRequest;
await eventFor(critical, 9);
duringPost = null;
dismissals.length = 0;
dismissFailure = true;
await assert.rejects(settleAfter([standing()]), /GitHub unavailable/);
dismissFailure = false;
assert.equal((run.publication as { state: string }).state, "pending", "a failed dismissal leaves the work pending");
await settleAfter([standing()]);
assert.deepEqual(dismissals, [901]);
assert.equal((run.publication as { state: string }).state, "dismissed");

// Only this app's own review, for the sent commit and event, active, and no older than the send, matches.
duringPost = admitNewRequest;
await eventFor(critical, 10);
duringPost = null;
dismissals.length = 0;
const issuedBefore = new Date(Date.now() - 600_000).toISOString();
await settleAfter([
  standing({ id: 1, user: "attacker" }),
  standing({ id: 2, state: "DISMISSED" }),
  standing({ id: 3, commitId: "d".repeat(40) }),
  standing({ id: 4, state: "APPROVED" }),
  standing({ id: 5, submittedAt: issuedBefore }),
]);
assert.deepEqual(dismissals, [], "a review that is not this app's, or not the one sent, must never be dismissed or adopted");
assert.equal((run.publication as { state: string }).state, "pending", "nothing matched yet, so it is checked again later");
assert.equal(jobs.at(-1)?.delay, 300);

// A verdict for the live request is left standing.
assert.equal(await eventFor(critical, 11), "REQUEST_CHANGES");
await settleAfter([standing()]);
assert.deepEqual(dismissals, []);
assert.equal((run.publication as { state: string }).state, "current");

// A lost answer is never sent again here, and no fallback is posted in its place.
postOutcome = "ambiguous";
assert.equal(await eventFor(critical, 12), "REQUEST_CHANGES");
assert.equal(events.length, 1, "an unknown outcome must not be resent");
assert.equal(summaries.some((body) => body.includes("Large PR")), false, "nor replaced by a fallback comment carrying the verdict summary");
assert.deepEqual(checkpoints.at(-1), { summaryPublished: true }, "the delivery is complete: the reconcile now owns the verdict");
assert.equal(jobs.length, 1);

// A request admitted before publication: nothing is sent, and nothing is recorded.
afterSave = admitNewRequest;
assert.equal(await eventFor(critical, 13), undefined, "a replaced request must not be published");
assert.equal(jobs.length, 0);
afterSave = null;

// Between the last read of the row and the write that publishes.
for (const reads of [1, 2, 3]) {
  admitAfterReads = reads; archivedReads = 0;
  assert.equal(await eventFor(critical, 14), undefined, `a request admitted after read ${reads} must not be published`);
  assert.equal(jobs.length, 0);
}
admitAfterReads = null;

// A record still pending long after its delay lost its job, and is scheduled again.
duringPost = admitNewRequest;
await eventFor(critical, 15);
duringPost = null;
jobs.length = 0;
assert.equal(await requeueUnresolvedPublications(new Date()), 0, "a record still within its delay is left to its own job");
assert.equal(await requeueUnresolvedPublications(new Date(Date.now() + 3600_000)), 1, "a record whose job was lost is scheduled again");
assert.deepEqual(jobs[0].options, { singletonKey: "publication:run-1", singletonSeconds: 900 }, "repeated sweeps do not stack jobs");

console.log("PASS large-review approval follows mayApprove");
