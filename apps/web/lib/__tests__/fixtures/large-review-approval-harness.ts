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
  reviewRun: { findUnique: async () => null, findFirst: async () => null, updateMany: async () => ({ count: 0 }) },
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
    deliver({ mainCommentId: null, summaryPublished: false }, async () => {}),
}));
mock.module("@/lib/review-summary-comment", () => ({ publishReviewSummary: async () => 1 }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));

const events: string[] = [];
const dismissals: number[] = [];
let afterSave: (() => void) | null = null;
let duringPost: (() => void) | null = null;
mock.module("@/lib/github", () => ({
  createPullRequestReview: async (...args: unknown[]) => { events.push(String(args[5])); duringPost?.(); return 901; },
  findReviewContaining: async () => null,
  dismissPullRequestReview: async (_i: number, _o: string, _r: string, _n: number, reviewId: number) => { dismissals.push(reviewId); },
  updateCheckRun: async () => {},
}));

const { handleLargeReviewResult } = await import("../../large-review-result");

const job = (reviewBody: string, n: number) => ({
  pullRequestId: "pr", attemptId: `0000000${n}-0000-4000-8000-000000000000`, headSha: head, baseSha: base,
  reviewRequestVersion: 1, reviewBody,
});
async function eventFor(reviewBody: string, n: number): Promise<string | undefined> {
  events.length = 0;
  dismissals.length = 0;
  Object.assign(row, { headSha: head, reviewRequestVersion: 1, reviewBody: "" });
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

// A request admitted while the review POST is in flight. The review then names a head
// nobody will merge, and a REQUEST_CHANGES stays in force on it until withdrawn.
duringPost = admitNewRequest;
assert.equal(await eventFor(critical, 6), "REQUEST_CHANGES");
assert.deepEqual(dismissals, [901], "a blocking review published for a request that was replaced meanwhile must be withdrawn");
assert.equal(await eventFor(completeClean, 7), "COMMENT");
assert.deepEqual(dismissals, [], "a comment holds nothing in force, so there is nothing to withdraw");
duringPost = null;

// A request admitted after the last check of the row and before the write that publishes:
// whatever ends the check, a replaced request must not be published.
for (const reads of [1, 2, 3]) {
  admitAfterReads = reads; archivedReads = 0;
  assert.equal(await eventFor(critical, 9), undefined, `a request admitted after read ${reads} must not be published`);
}
admitAfterReads = null;

// A request admitted before publication: nothing is sent at all.
afterSave = admitNewRequest;
assert.equal(await eventFor(critical, 8), undefined, "a replaced request must not be published");
afterSave = null;

console.log("PASS large-review approval follows mayApprove");
