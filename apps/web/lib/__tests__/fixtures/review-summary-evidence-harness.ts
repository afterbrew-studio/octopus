import { mock } from "bun:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";

mock.module("server-only", () => ({}));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ appId: "1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) }) }));
const head = "a".repeat(40);
const current = { headSha: head, reviewRequestVersion: 1, reviewCommentId: null as number | null, status: "pending", reviewBody: null as string | null };
const archives = Array.from({ length: 7 }, (_, i) => ({ id: `11111111-2222-4333-8444-${String(i).padStart(12, "0")}`, headSha: head, createdAt: new Date(`2026-09-${String(11-i).padStart(2,"0")}T12:00:00Z`), reviewBody: `Immutable report ${i}` }));
const originalArchives = structuredClone(archives);
const db = {
  $queryRaw: async () => [{ ...current }],
  reviewAttempt: { findMany: async ({ take }: { take: number }) => archives.slice(0, take) },
  pullRequest: { updateMany: async ({ data }: { data: Partial<typeof current> }) => { Object.assign(current, data); return { count: 1 }; } },
};
mock.module("@octopus/db", () => ({ prisma: { $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db) } }));
const calls: { method: string; url: string; id: number; body: string }[] = [];
const comments = new Map<number, string>([[12, "Earlier historical comment remains unchanged"]]);
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/access_tokens")) return Response.json({ token: "fixture-token" });
  assert.ok(url.startsWith("https://api.github.com/repos/fixture/repo/"));
  const method = init?.method ?? "GET";
  assert.ok(method === "POST" || method === "PATCH");
  const id = method === "POST" ? 100 : Number(url.split("/").at(-1));
  const body = JSON.parse(String(init?.body)).body;
  comments.set(id, body);
  calls.push({ method, url, id, body });
  return Response.json({ id });
}) as typeof fetch;
const { publishReviewSummary } = await import("../../review-summary-comment");
const { prepareReviewInput, applyReviewCoverage } = await import("../../review-coverage");
const target = { pullRequestId: "fixture-pr", headSha: head, reviewRequestVersion: 1, installationId: 1, owner: "fixture", repo: "repo", prNumber: 833 };
await publishReviewSummary({ ...target, body: "> 🐙 **Octopus Review** is queued. This summary will update when the review finishes." });
current.status = "reviewing";
await publishReviewSummary({ ...target, body: "> 🐙 **Octopus Review** — Preparing review..." });
const plan = prepareReviewInput({ provider: "github", headSha: head, baseSha: "b".repeat(40), inventoryComplete: true, expectedFiles: 236, limitations: [], files: Array.from({ length: 236 }, (_, i) => ({ path: `src/file-${i}.ts`, change: "added", patch: "@@ -0,0 +1 @@\n+export const x = 1;\n" })) }, { maxChars: 100000 });
plan.coverage.files.forEach((file, i) => { file.state = i < 74 ? "supplied" : i < 125 ? "omitted" : i < 177 ? "unavailable" : "excluded"; });
plan.coverage.complete = false;
const saved = applyReviewCoverage("## 🐙 Octopus Review\n\n### Findings\nRetained finding on src/file-235.ts.\n", plan.coverage, archives[0].id);
current.status = "completed";
current.reviewBody = saved;
await publishReviewSummary({ ...target, body: saved, expectedReviewBody: saved });
assert.equal(await publishReviewSummary({ ...target, body: "Late progress" }), null);
assert.equal(await publishReviewSummary({ ...target, body: "Stale result", expectedReviewBody: "replaced" }), null);
assert.deepEqual(calls.map(({ method, id }) => [method, id]), [["POST", 100], ["PATCH", 100], ["PATCH", 100]]);
const published = comments.get(100)!;
assert.ok(published.includes("74/236 files fully supplied, 0 partial, 51 omitted, 52 unavailable, 59 excluded"));
assert.ok(published.includes("Overall: not assessed"));
assert.ok(published.includes("Retained finding"));
assert.ok(!published.includes("src/file-0.ts"));
assert.ok(published.includes(`Review history: https://octopus-review.ai/review-attempts/${archives[0].id}`));
assert.ok(!published.includes("Review history (latest") && !published.includes("organization access") && !published.includes("sign-in required"));
assert.ok(published.includes("Full coverage and review record: https://"));
assert.ok(calls.every(call => !/<details>|<summary>|<!-- octopus-summary:|\[Full coverage and review record\]/.test(call.body)));
assert.ok(calls[0].body.includes("Octopus publication reference: fixture-pr:"));
assert.ok(!published.includes("Octopus publication reference:"));
assert.ok(!published.includes(archives[5].id));
assert.equal(comments.get(12), "Earlier historical comment remains unchanged");
assert.equal(current.reviewBody, saved);
assert.deepEqual(archives, originalArchives);
if (process.env.REVIEW_EVIDENCE_DIR) {
  const dir = process.env.REVIEW_EVIDENCE_DIR;
  await Bun.write(join(dir, "github-summary.md"), published);
  await Bun.write(join(dir, "immutable-record.md"), saved);
  await Bun.write(join(dir, "publication-sequence.json"), JSON.stringify({ boundary: "Real publisher and GitHub HTTP adapter; in-memory database and simulated GitHub responses", calls, historicalComment: comments.get(12) }, null, 2));
  await Bun.write(join(dir, "github-summary.html"), `<!doctype html><meta charset="utf-8"><title>Generated GitHub summary</title><body><p>Actual emitted Markdown rendered locally; simulated GitHub transport.</p><article>${Bun.markdown.html(published)}</article></body>`);
}
console.log("PASS real publisher and HTTP formatter: queued → running → completed update comment 100; one readable history link; immutable archive and historical comment retained");
