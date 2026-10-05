import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));

/**
 * The large-review result path decides APPROVE on its own, so it has to reach
 * the same answer as the ordinary path's `mayApprove`. Persistence and delivery
 * are stubbed; what is asserted is the review event handed to GitHub.
 */

let storedBody = "";
let org = { id: "org", approveWhenClean: true, checkFailureThreshold: "critical", defaultReviewConfig: null };
const db = {
  pullRequest: {
    findUnique: async () => ({
      id: "pr", number: 7, title: "Large change", url: "https://example.test/pr/7",
      headSha: "a".repeat(40), reviewRequestVersion: 1, reviewBody: storedBody,
      repository: { id: "repo", provider: "github", fullName: "owner/repo", installationId: 1, reviewConfig: null, organization: org },
    }),
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
  saveReviewAttempt: async (_id: string, _pr: string, _coverage: unknown, reviewBody: string) => { storedBody = reviewBody; return true; },
  updateCurrentReview: async () => ({ count: 1 }),
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
mock.module("@/lib/github", () => ({
  createPullRequestReview: async (...args: unknown[]) => { events.push(String(args[5])); return 901; },
  updateCheckRun: async () => {},
}));

const { handleLargeReviewResult } = await import("../../large-review-result");

const head = "a".repeat(40), base = "c".repeat(40);
const job = (reviewBody: string, n: number) => ({
  pullRequestId: "pr", attemptId: `0000000${n}-0000-4000-8000-000000000000`, headSha: head, baseSha: base,
  reviewRequestVersion: 1, reviewBody,
});
async function eventFor(reviewBody: string, n: number): Promise<string | undefined> {
  events.length = 0;
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

console.log("PASS large-review approval follows mayApprove");
