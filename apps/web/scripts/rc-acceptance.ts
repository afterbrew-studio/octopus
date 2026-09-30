/** Bundled into the runtime image; synthetic callbacks never contact GitHub. */
import assert from "node:assert/strict";
import { fetchGitHubReviewInput } from "../lib/github-review-input";
import { prepareReviewInput, reviewCheckResult } from "../lib/review-coverage";
import { parseDiffLines, buildInlineComments } from "../lib/review-helpers";

const head = "1".repeat(40), base = "2".repeat(40);
const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const path = ".review-evidence/check.stderr.log";
const file = { filename: path, status: "added", additions: 0, deletions: 0, sha: blob };
const diff = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${blob.slice(0, 7)}\n`;
async function input(files: unknown[], rawDiff = diff) {
  return (await fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1000,
    fetchDiff: async () => rawDiff,
    readJson: async suffix => suffix ? files : { head: { sha: head }, base: { sha: base }, changed_files: files.length },
  })).input;
}

for (const patch of [undefined, null]) {
  const review = await input([{ ...file, patch }]);
  const prepared = prepareReviewInput(review, { maxChars: 1000 });
  assert.equal(prepared.coverage.complete, true);
  assert.equal(prepared.coverage.files[0].state, "supplied");
  assert.match(prepared.diff, /Empty file \(0 bytes\)/);
  assert.equal(prepared.diff.includes("@@"), false);
  assert.equal(reviewCheckResult(prepared.coverage, false, 0).conclusion, "failure");
  assert.equal(prepareReviewInput(review, { maxChars: prepared.diff.length - 1 }).coverage.complete, false);
  const empty = review.files[0];
  const real = { path: ".aaa.ts", change: "modified", additions: 1, deletions: 1,
    patch: "@@ -20,2 +20,2 @@\n context\n-old\n+new\n" };
  const finding = { filePath: path, startLine: 1, endLine: 1, severity: "🟡", title: "Empty file",
    description: "No source lines", category: "quality", suggestion: "", confidence: 90 };
  for (const files of [[empty], [real, empty]]) {
    const mixed = prepareReviewInput({ ...review, files, expectedFiles: files.length }, { maxChars: 1000 });
    assert.equal(mixed.coverage.complete, true);
    const lines = parseDiffLines(mixed.diff);
    assert.deepEqual([...(lines.get(path) ?? [])], []);
    assert.equal(lines.has(path), true);
    assert.deepEqual(buildInlineComments([finding, { ...finding, startLine: 22, endLine: 22 }], lines), []);
    if (files.length > 1) {
      assert.deepEqual([...lines.get(".aaa.ts")!], [20, 21]);
      const comments = buildInlineComments([{ ...finding, filePath: ".aaa.ts", startLine: 21, endLine: 21 }], lines);
      assert.equal(comments.length, 1);
      assert.equal(comments[0].path, ".aaa.ts");
      assert.equal(comments[0].line, 21);
    }
  }
}
for (const change of [{ sha: "a".repeat(40) }, { additions: 1 }, { status: "modified" }, { patch: "bad patch" }]) {
  assert.equal(prepareReviewInput(await input([{ ...file, ...change }]), { maxChars: 1000 }).coverage.complete, false);
}
assert.equal(prepareReviewInput(await input([file], diff.replace("100644", "120000")), { maxChars: 1000 }).coverage.complete, false);
console.log(JSON.stringify({ schema: 1, checks: ["empty-omitted-patch", "empty-null-patch", "coverage-not-assessment",
  "budget-refusal", "empty-inline", "mixed-inline", "conflicting-evidence"] }));
