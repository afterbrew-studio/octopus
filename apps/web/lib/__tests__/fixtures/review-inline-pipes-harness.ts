import { mock } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

mock.module("server-only", () => ({}));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({
  appId: "1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
}) }));
const head = "a".repeat(40);
const current = { headSha: head, reviewRequestVersion: 1, reviewCommentId: null as number | null,
  status: "completed", reviewBody: "" };
const archived = [{ id: "11111111-2222-4333-8444-555555555555", headSha: head,
  createdAt: new Date("2026-09-11T20:44:12Z"), reviewBody: "" }];
const tx = {
  $queryRaw: async () => [{ ...current }],
  reviewAttempt: { findMany: async () => archived },
  pullRequest: { updateMany: async ({ data }: { data: { reviewCommentId: number } }) => {
    current.reviewCommentId = data.reviewCommentId; return { count: 1 };
  } },
};
mock.module("@octopus/db", () => ({ prisma: { $transaction: async (run: (value: typeof tx) => unknown) => run(tx) } }));
const calls: { method: string; body: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/access_tokens")) return Response.json({ token: "fixture-token" });
  assert.ok(url.startsWith("https://api.github.com/repos/fixture/repo/"));
  assert.ok(init?.method === "POST" || init?.method === "PATCH");
  calls.push({ method: init.method, body: JSON.parse(String(init.body)).body });
  return Response.json({ id: 123 });
}) as typeof fetch;
const { publishReviewSummary } = await import("../../review-summary-comment");
const target = { pullRequestId: "fixture-pr", headSha: head, reviewRequestVersion: 1,
  installationId: 1, owner: "fixture", repo: "repo", prNumber: 1 };
// The two observed prose shapes are synthetic; private customer source is not a fixture.
const prose = "### Summary\nStatuses are `available|partial|missing|conflicting`.\n\n### Risk Assessment\nThe field has type `string | null`.";
const score = "### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| **Overall** | **5/5** | No defects |";
const original = `## 🐙 Octopus Review\n\n${prose}\n\n${score}\n\nLast reviewed commit: ${head}`;
current.reviewBody = original;
archived[0].reviewBody = original;
const before = structuredClone(archived);
for (const expectedMethod of ["POST", "PATCH"]) {
  await publishReviewSummary({ ...target, body: original, expectedReviewBody: original });
  const output = calls.at(-1)!;
  assert.equal(output.method, expectedMethod);
  assert.ok(!output.body.includes("`available|partial|missing|conflicting`"));
  assert.ok(!output.body.includes("`string | null`"));
  const displayedProse = output.body.split("### Score")[0];
  const originalProse = original.split("### Score")[0];
  const withoutCodeTags = (body: string) => Bun.markdown.html(body).replace(/<\/?code>/g, "");
  assert.equal(withoutCodeTags(displayedProse), withoutCodeTags(originalProse));
  assert.ok(output.body.includes(score));
  assert.ok(output.body.endsWith(`Last reviewed commit: ${head}`));
  assert.equal(current.reviewBody, original);
  assert.deepEqual(archived, before);
}
console.log("PASS actual POST/PATCH keeps rendered pipe text, score and immutable records");

// Run pathological Markdown only in this killable child process. A synchronous
// parser cannot be interrupted by a timer in its own event loop.
const { formatReviewInlinePipes } = await import("../../review-comment-markdown");
for (const source of [
  "[".repeat(30_000) + "`a|b`" + "]".repeat(30_000),
  "[x ".repeat(8_000) + "`a|b`" + " ]".repeat(8_000),
  "a".repeat(64_000) + " `a|b`",
  "!".repeat(2_046) + " `a|b`", // Aggregate punctuation, including the span, exceeds 2,048.
]) {
  assert.equal(formatReviewInlinePipes(source), source);
  const body = `## 🐙 Octopus Review\n\n${source}\n\n${score}\n\nLast reviewed commit: ${head}`;
  current.reviewBody = body;
  archived[0].reviewBody = body;
  const saved = structuredClone(archived);
  await publishReviewSummary({ ...target, body, expectedReviewBody: body });
  const output = calls.at(-1)!;
  assert.equal(output.method, "PATCH");
  if (body.length < 60_500) assert.ok(output.body.includes(source));
  else assert.ok(output.body.length <= 64_000);
  assert.equal(current.reviewBody, body);
  assert.deepEqual(archived, saved);
}
for (const source of ["a".repeat(63_995) + "`a|b`", "!".repeat(2_045) + " `a|b`"]) {
  assert.notEqual(formatReviewInlinePipes(source), source);
  assert.equal(formatReviewInlinePipes(formatReviewInlinePipes(source)), formatReviewInlinePipes(source));
}
console.log("PASS bounded formatting retains unsupported inputs and immutable records");
