import { reconcileScoreTable, stripDetailedFindings } from "@/lib/review-helpers";
import { describe, expect, it } from "bun:test";
import { buildGeneratedMatcher } from "@/lib/generated-files";
import { sha256, prepareReviewInput, inspectReviewPatch, applyReviewCoverage, renderReviewCoverage, coverageCounts, unknownReviewCoverage, reviewCheckResult, type ReviewInput } from "@/lib/review-coverage";
import { fetchGitHubReviewInput } from "@/lib/github-review-input";
import { createCoveredReviewRequest } from "@/lib/review-request";
import { prepareReviewComment } from "@/lib/review-comment-context";
import { readReviewJson } from "@/lib/review-fetch";

const completedAssessment = { state: "completed" as const, reason: "Completed fixture", model: "test", policySha256: "a".repeat(64), templateSha256: "b".repeat(64), requests: [{ provider: "openai" as const, model: "test", inputPreserved: true, sha256: "c".repeat(64) }], responseSha256: "d".repeat(64), completion: { state: "completed" as const, reason: "stop" } };

const head = "1".repeat(40), base = "2".repeat(40);
const patch = (text = "export const validate = () => true;") => `@@ -0,0 +1 @@\n+${text}\n`;
const input = (files: ReviewInput["files"]): ReviewInput => ({ provider: "github", headSha: head, baseSha: base, inventoryComplete: true, expectedFiles: files.length, files, limitations: [] });

describe("review input coverage", () => {
  it("renders plain Markdown evidence without losing metadata, coverage states or escaped source text", () => {
    const states = ["supplied", "partial", "omitted", "excluded", "unavailable"] as const;
    const plan = prepareReviewInput(input(states.map(state => ({ path: `src/${state}.ts`, change: "added", patch: patch() }))), { maxChars: 10000 });
    plan.coverage.files.forEach((file, i) => { file.state = states[i]; file.reason = `Reason ${states[i]}`; });
    plan.coverage.files[0].path = "src/<tag>&|`\n.ts";
    plan.coverage.files[0].reason = "<reason>&|`\r\ncontinued";
    plan.coverage.complete = false;
    plan.coverage.comment = { receivedChars: 50, suppliedChars: 20, truncated: true, verifiedAsChangedSource: false };
    const before = structuredClone(plan.coverage);
    const rendered = renderReviewCoverage(plan.coverage, "attempt-plain");
    const attemptUrl = new URL("/api/review-attempts/attempt-plain", process.env.NEXT_PUBLIC_APP_URL ?? "https://octopus-review.ai").href;
    expect(rendered).toContain(`Attempt: attempt-plain ${attemptUrl}.\nHead: \`${head}\`. Base: \`${base}\`.`);
    expect(rendered).toContain("#### Changed-file coverage (5 known paths)");
    expect(rendered).not.toMatch(/<\/?(?:details|summary)>|Attempt: \[/);
    expect(rendered).toContain("1/5 files fully supplied, 1 partial, 1 omitted, 1 unavailable, 1 excluded");
    expect(rendered).toContain("20/50 characters supplied (truncated)");
    expect(rendered).toContain("source excerpts and hashes remain unverified and do not add changed-file coverage");
    expect(rendered).toContain("**Overall: not assessed — incomplete coverage.**");
    expect(rendered).toContain("| src/&lt;tag&gt;&amp;&#124;&#96; .ts | supplied | &lt;reason&gt;&amp;&#124;&#96;  continued |");
    for (const state of states.slice(1)) expect(rendered).toContain(`| src/${state}.ts | ${state} | Reason ${state} |`);
    expect(plan.coverage).toEqual(before);
  });

  it("retains late source after an early huge fixture in the 203-file provider case", async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ filename: `fixtures/${String(i).padStart(3, "0")}.json`, status: "added", additions: 1, deletions: 0, patch: patch(i === 0 ? "x".repeat(1_800_000) : "{}") }));
    for (const path of ["package.json", "src/validation.ts", "scripts/artifacts.ts"]) files.push({ filename: path, status: "added", additions: 1, deletions: 0, patch: patch(`SOURCE:${path}`) });
    const calls: string[] = [];
    const fetched = await fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1_500_000, fetchDiff: async () => "fixture prefix", readJson: async suffix => {
      calls.push(suffix);
      if (!suffix) return { head: { sha: head }, base: { sha: base }, changed_files: files.length };
      const page = Number(new URL("https://example.test" + suffix).searchParams.get("page"));
      return files.slice((page - 1) * 100, page * 100);
    } });
    expect(calls).toEqual(["", "/files?per_page=100&page=1", "/files?per_page=100&page=2", "/files?per_page=100&page=3", ""]);
    const plan = prepareReviewInput(fetched.input, { maxChars: 300_000 });
    const request = createCoveredReviewRequest({ model: "test", system: "Review policy", number: 801, title: "Contracts", author: "author", diff: plan.diff, coverage: plan.coverage, comment: "", repoConfig: "" });
    const received = request.messages[0].content as string;
    for (const path of ["package.json", "src/validation.ts", "scripts/artifacts.ts"]) {
      expect(received).toContain(`SOURCE:${path}`);
      expect(plan.coverage.files.find(f => f.path === path)?.state).toBe("supplied");
    }
    expect(plan.coverage.files).toHaveLength(203);
    expect(coverageCounts(plan.coverage)).toEqual({ total: 203, supplied: 202, partial: 0, omitted: 0, unavailable: 1, excluded: 0 });
    expect(plan.coverage.complete).toBe(false);
    const body = applyReviewCoverage("### Score\n| Overall | 5/5 |\n\n### Findings\nNo findings.", plan.coverage, "attempt-801");
    expect(body).not.toContain("5/5");
    expect(body).toContain("Review incomplete");
    expect(body).toContain("202/203");
    expect(reviewCheckResult(plan.coverage, false, 0).conclusion).toBe("failure");
    if (process.env.REVIEW_TEST_EVIDENCE_DIR) {
      const directory = process.env.REVIEW_TEST_EVIDENCE_DIR;
      await Bun.write(`${directory}/coverage-contract.json`, JSON.stringify({
        providerRequests: calls, modelRequest: request, coverage: plan.coverage,
        report: body, nativeCheck: reviewCheckResult(plan.coverage, false, 0),
      }, null, 2));
      await Bun.write(`${directory}/incomplete-report.html`, "<!doctype html><meta charset=\"utf-8\"><title>Generated incomplete review report</title>" +
        Bun.markdown.html(body));
    }
  });

  it("uses complete hunks only and reports per-file overflow", () => {
    const first = "@@ -0,0 +1 @@\n+one\n", second = "@@ -4,0 +5 @@\n+two\n";
    const data = input([{ path: "src/a.ts", change: "modified", patch: first + second }]);
    const full = prepareReviewInput(data, { maxChars: 1000 });
    const exact = prepareReviewInput(data, { maxChars: full.diff.length });
    expect(exact.coverage.complete).toBe(true);
    expect(exact.coverage.files[0].hunks.map(h => h.sha256)).toEqual([sha256(first), sha256(second)]);
    expect(exact.coverage.files[0].suppliedSha256).toBe(sha256(exact.diff));
    const partial = prepareReviewInput(data, { maxChars: full.diff.length - 1 });
    expect(partial.coverage.files[0].state).toBe("partial");
    expect(partial.coverage.files[0].hunks).toEqual([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, sha256: sha256(first) }]);
    expect(partial.diff).not.toContain("+two");
    expect(partial.diff.length).toBeLessThan(full.diff.length - 1);
  });

  it("does not trust generated labels to hide source or schemas", () => {
    const files = ["src/auth.ts", "schemas/access.json", "fixtures/access.json", "bun.lock"].map(path => ({ path, change: "added", patch: patch() }));
    const plan = prepareReviewInput(input(files), { maxChars: 10000, generated: buildGeneratedMatcher("src/** linguist-generated\nschemas/** -diff\n") });
    expect(plan.coverage.files.map(f => [f.path, f.state])).toEqual([["src/auth.ts", "supplied"], ["schemas/access.json", "supplied"], ["fixtures/access.json", "supplied"], ["bun.lock", "excluded"]]);
    expect(plan.coverage.complete).toBe(true);
  });

  it("detects missing patch tails even if the final hunk counts look complete", () => {
    const plan = prepareReviewInput(input([{ path: "a.ts", change: "added", patch: patch(), additions: 2, deletions: 0 }]), { maxChars: 10000 });
    expect(plan.coverage.files[0].state).toBe("partial");
    expect(plan.coverage.complete).toBe(false);
    expect(inspectReviewPatch("@@ -1,2 +1,2 @@\n one\n").complete).toBe(false);
  });

  it("keeps binary, unsafe path and unknown inventory failures explicit", () => {
    const data = input([{ path: "asset.png", change: "added" }, { path: "bad\npath.ts", change: "added", patch: patch() }]);
    data.inventoryComplete = false; data.expectedFiles = 3001;
    const plan = prepareReviewInput(data, { maxChars: 1000 });
    expect(plan.coverage.files.every(f => f.state === "unavailable")).toBe(true);
    expect(plan.coverage.complete).toBe(false);
    expect(applyReviewCoverage("Overall 4/5", unknownReviewCoverage("github", "legacy result"), "legacy")).not.toContain("4/5");
  });

  it("rejects provider head drift before any review request can be built", async () => {
    let reads = 0;
    await expect(fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1000, fetchDiff: async () => "", readJson: async suffix => {
      if (suffix) return [{ filename: "a.ts", status: "added", patch: patch() }];
      return { head: { sha: ++reads === 1 ? head : "3".repeat(40) }, base: { sha: base }, changed_files: 1 };
    } })).rejects.toThrow("revision changed");
  });

  it("does not call a missing page a complete inventory", async () => {
    const result = await fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1000, fetchDiff: async () => "", readJson: async suffix => suffix ? [] : { head: { sha: head }, base: { sha: base }, changed_files: 203 } });
    expect(result.input.inventoryComplete).toBe(false);
  });

  it("sends a 59k supplement once as data without claiming it verifies coverage", () => {
    const comment = "@octopus " + "SUPPLEMENT:" + "x".repeat(59000);
    const plan = prepareReviewInput(input([{ path: "src/auth.ts", change: "added" }]), { maxChars: 300000 });
    const request = createCoveredReviewRequest({ model: "test", system: "Trusted policy", number: 1, title: "title", author: "a", diff: plan.diff, coverage: plan.coverage, comment, repoConfig: "" });
    expect(request.system).toBe("Trusted policy");
    expect((request.messages[0].content as string).split("SUPPLEMENT:")).toHaveLength(2);
    expect(prepareReviewComment(comment).receipt).toEqual({ receivedChars: 59011, suppliedChars: 59011, truncated: false, verifiedAsChangedSource: false });
    expect(plan.coverage.complete).toBe(false);
    const cut = prepareReviewComment("@octopus x😀tail", 2);
    expect(cut.receipt).toEqual({ receivedChars: 7, suppliedChars: 1, truncated: true, verifiedAsChangedSource: false });
  });

  it("keeps ordinary complete reviews and severity gating compatible", () => {
    const plan = prepareReviewInput(input([{ path: "a.ts", change: "added", patch: patch(), additions: 1, deletions: 0 }]), { maxChars: 1000 });
    plan.coverage.assessment = completedAssessment;
    expect(reviewCheckResult(plan.coverage, false, 0).conclusion).toBe("success");
    expect(reviewCheckResult(plan.coverage, true, 1).conclusion).toBe("failure");
    const report = "### Score\n| Overall | 4/5 |\n";
    expect(applyReviewCoverage(report, plan.coverage, "attempt")).toContain(report);
  });

  it("rejects oversized serialized pages rather than returning a partial manifest", async () => {
    await expect(readReviewJson(new Response(JSON.stringify({ text: "x".repeat(30) })), 20)).rejects.toThrow("fetch budget");
    expect(await readReviewJson(new Response('{"path":"é"}'), 100)).toEqual({ path: "é" });
  });
});


it("reconciles archived and published scores without changing findings JSON", () => {
  const payload = '<!-- OCTOPUS_FINDINGS_START -->\n[{"description":"example 3/5"}]\n<!-- OCTOPUS_FINDINGS_END -->';
  const body = "### Score\n| Overall | 3/5 |\n\n" + payload;
  const plan = prepareReviewInput(input([{ path: "a.ts", change: "added", patch: patch() }]), { maxChars: 1000 });
  plan.coverage.assessment = completedAssessment;
  const report = applyReviewCoverage(body, plan.coverage, "attempt");
  const flags = { hasCritical: false, hasHigh: false, hasMedium: false };
  const archived = reconcileScoreTable(report, flags);
  const published = reconcileScoreTable(stripDetailedFindings(report), flags);
  expect(archived).toContain("| Overall | 4/5 |");
  expect(archived).toContain(payload);
  expect(stripDetailedFindings(archived)).toBe(published);
  expect(reconcileScoreTable(report, { ...flags, hasHigh: true })).toBe(report);
  const incomplete = applyReviewCoverage(body, unknownReviewCoverage("github", "legacy"), "unknown");
  expect(stripDetailedFindings(incomplete)).not.toContain("3/5");
  expect(incomplete).toContain(payload);
});

it("passes the pinned revision to a failed large-diff handoff", async () => {
  const error = new Error("large diff");
  let identity: unknown;
  await expect(fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1000,
    readJson: async () => ({ head: { sha: head }, base: { sha: base } }),
    fetchDiff: async () => { throw error; },
    onDiffError: (caught, revision) => { expect(caught).toBe(error); identity = revision; },
  })).rejects.toThrow("large diff");
  expect(identity).toEqual({ headSha: head, baseSha: base });
});


it("keeps complete input distinct from an invalid assessment and removes every score", () => {
  const plan = prepareReviewInput(input([{ path: "a.ts", change: "added", patch: patch() }]), { maxChars: 1000 });
  plan.coverage.assessment = { ...completedAssessment, state: "incomplete", reason: "Findings Summary counts do not match findings JSON" };
  const payload = '<!-- OCTOPUS_FINDINGS_START -->\n[{"description":"Security 5/5 is an untrusted example"}]\n<!-- OCTOPUS_FINDINGS_END -->';
  const variants = [
    "### Score\n| Category | Score | Notes |\n| --- | --- | --- |\n| Security | 5/5 | note |\n| Code Quality | 4/5 | note |\n| **Overall** | **4/5** | note |\n\n### Summary\nKeep the summary.\n",
    "### Score\n| Security | 5/5 | note |\n| Overall | 4/5 | note |",
    "### Score\n| Security | 5/5 | note |\n### Score\n| Error Handling | 3/5 | note |\n| Overall | 3/5 | note |",
    "| Security | 5/5 | note |\n| **Overall** | **4/5** | note |\nPerformance: 4/5\nConsistency: N/A",
  ];
  for (const body of variants) {
    const rendered = applyReviewCoverage(body + "\n" + payload, plan.coverage, "invalid");
    const visible = stripDetailedFindings(rendered);
    expect(visible).not.toMatch(/[1-5]\/5|N\/A/);
    expect(rendered).toContain(payload);
    expect(rendered).toContain("Input complete; assessment invalid or unavailable");
    expect(rendered).not.toContain("incomplete coverage");
    expect(rendered).toContain(plan.coverage.assessment.reason);
  }
  expect(plan.coverage.complete).toBe(true);
  expect(reviewCheckResult(plan.coverage, false, 0).conclusion).toBe("failure");
});
