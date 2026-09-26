import { describe, expect, it } from "bun:test";
import { fetchGitHubReviewInput } from "@/lib/github-review-input";
import { applyReviewCoverage, coverageCounts, prepareReviewInput, reviewCheckResult, sha256, type ReviewInput } from "@/lib/review-coverage";
import { recordNoModelAssessment } from "@/lib/review-assessment";
import { parseOctopusIgnore } from "@/lib/octopus-ignore";
import { buildGeneratedMatcher } from "@/lib/generated-files";

const head = "1".repeat(40), base = "2".repeat(40);
const blob = "a".repeat(40);
const png = (filename = "docs/screenshot.png") => ({ filename, status: "added", additions: 0, deletions: 0, sha: blob });
const binaryDiff = (filename = "docs/screenshot.png") => `diff --git a/${filename} b/${filename}\nnew file mode 100644\nindex 0000000..${blob.slice(0, 7)}\nBinary files /dev/null and b/${filename} differ\n`;
const modifiedDiff = `diff --git a/docs/screenshot.png b/docs/screenshot.png\nindex bbbbbbb..${blob.slice(0, 7)} 100644\nBinary files a/docs/screenshot.png and b/docs/screenshot.png differ\n`;

async function fetchInput(files: unknown[], rawDiff: string) {
  return fetchGitHubReviewInput({
    expectedHead: head, maxPatchChars: 100_000,
    fetchDiff: async () => rawDiff,
    readJson: async suffix => suffix ? files : { head: { sha: head }, base: { sha: base }, changed_files: files.length },
  });
}

describe("GitHub binary PNG coverage", () => {
  it("retains two declared PNGs as unreviewed exclusions beside the supplied README", async () => {
    const patch = "@@ -0,0 +1 @@\n+Product documentation\n";
    const readme = { filename: "README.md", status: "added", additions: 1, deletions: 0, patch };
    const rawDiff = "diff --git a/README.md b/README.md\nnew file mode 100644\n--- /dev/null\n+++ b/README.md\n" + patch
      + binaryDiff("docs/sign-in.png") + binaryDiff("docs/review.png");
    const fetched = await fetchInput([readme, png("docs/sign-in.png"), png("docs/review.png")], rawDiff);
    const prepared = prepareReviewInput(fetched.input, { maxChars: 100_000 });
    expect(coverageCounts(prepared.coverage)).toEqual({ total: 3, supplied: 1, partial: 0, omitted: 0, excluded: 2, unavailable: 0 });
    expect(prepared.coverage.complete).toBe(true);
    expect(reviewCheckResult(prepared.coverage, false, 0).conclusion).toBe("failure"); // Model assessment still required.
    const readmeOnly = await fetchInput([readme], rawDiff.split("diff --git a/docs/")[0]);
    expect(sha256(prepared.diff)).toBe(sha256(prepareReviewInput(readmeOnly.input, { maxChars: 100_000 }).diff));
    for (const file of prepared.coverage.files.slice(1)) {
      expect(file.suppliedChars).toBe(0);
      expect(file.suppliedSha256).toBeNull();
      expect(file.hunks).toEqual([]);
      expect(file.reason).toContain("not reviewed");
      expect(file.binaryEvidence).toMatchObject({ policy: "github-binary-assets-v2", assetKind: "image", provider: "github", headSha: head, baseSha: base, path: file.path, change: "added", blobSha: blob });
      expect(file.binaryEvidence?.rawSectionSha256).toBe(sha256(binaryDiff(file.path)));
    }
  });

  it("accepts modified regular PNGs with a distinct old blob and a full new blob hash", async () => {
    const fetched = await fetchInput([{ ...png(), status: "modified" }], modifiedDiff.replace("..aaaaaaa ", `..${blob} `));
    const prepared = prepareReviewInput(fetched.input, { maxChars: 0 });
    expect(prepared.coverage.files[0]).toMatchObject({ state: "excluded", suppliedChars: 0, hunks: [], binaryEvidence: { change: "modified", blobSha: blob } });
    expect(prepared.diff).toBe("");
    expect(prepared.inventoryDiff).toContain("docs/screenshot.png");
  });

  it("records excluded-only input without invoking or claiming a model assessment", async () => {
    const fetched = await fetchInput([png()], binaryDiff());
    const prepared = prepareReviewInput(fetched.input, { maxChars: 0 });
    recordNoModelAssessment(prepared.coverage);
    expect(prepared.coverage.assessment).toMatchObject({ state: "not-required", model: null, requests: [], responseSha256: null });
    expect(reviewCheckResult(prepared.coverage, false, 0).conclusion).toBe("success");
    const report = applyReviewCoverage("Overall 5/5", prepared.coverage, "binary-only");
    expect(report).not.toContain("5/5");
    expect(report).toContain("excluded files were not reviewed");
  });

  const invalidMetadata: [string, Record<string, unknown>][] = [
    ["missing additions", { additions: undefined }], ["missing deletions", { deletions: undefined }],
    ["nonzero additions", { additions: 1 }], ["negative deletions", { deletions: -1 }],
    ["string count", { additions: "0" }], ["null count", { deletions: null }],
    ["missing blob", { sha: undefined }], ["empty blob", { sha: "" }],
    ["short blob", { sha: "aaaaaaa" }], ["nonhex blob", { sha: "g".repeat(40) }],
    ["different blob", { sha: "b".repeat(40) }], ["null blob", { sha: "0".repeat(40) }],
    ["renamed", { status: "renamed" }], ["copied", { status: "copied" }],
    ["deleted", { status: "removed" }], ["unknown status", { status: "changed" }],
    ["wrong status", { status: "modified" }], ["previous path", { previous_filename: "old.png" }],
    ["same previous path", { previous_filename: "docs/screenshot.png" }],
    ["empty API patch", { patch: "" }], ["null API patch", { patch: null }],
    ["retained patch overflow", { patch: "x".repeat(100_001) }],
  ];
  for (const [name, changes] of invalidMetadata) {
    it(`does not exclude an image with ${name}`, async () => {
      const fetched = await fetchInput([{ ...png(), ...changes }], binaryDiff());
      expect(fetched.input.files[0].binaryEvidence).toBeUndefined();
      const prepared = prepareReviewInput(fetched.input, { maxChars: 1000 });
      expect(prepared.coverage.complete).toBe(false);
      expect(prepared.coverage.files[0].state).toBe("unavailable");
    });
  }

  const invalidDiffs: [string, string][] = [
    ["missing declaration", ""], ["bare marker", "Binary files /dev/null and b/docs/screenshot.png differ\n"],
    ["missing marker", binaryDiff().split("Binary files")[0]],
    ["truncated marker", binaryDiff().replace(" differ\n", " diffe")],
    ["short prefix", binaryDiff().replace("..aaaaaaa", "..aaaaaa")],
    ["empty prefix", binaryDiff().replace("..aaaaaaa", "..")],
    ["nonhex prefix", binaryDiff().replace("..aaaaaaa", "..ggggggg")],
    ["overlong prefix", binaryDiff().replace("..aaaaaaa", ".." + "a".repeat(41))],
    ["different prefix", binaryDiff().replace("..aaaaaaa", "..bbbbbbb")],
    ["added old blob", binaryDiff().replace("0000000..", "bbbbbbb..")],
    ["executable mode", binaryDiff().replace("100644", "100755")],
    ["symlink mode", binaryDiff().replace("100644", "120000")],
    ["submodule mode", binaryDiff().replace("100644", "160000")],
    ["missing mode", binaryDiff().replace("new file mode 100644\n", "")],
    ["wrong old header", binaryDiff().replace("a/docs/screenshot.png b/", "a/old.png b/")],
    ["wrong new header", binaryDiff().replace("b/docs/screenshot.png\n", "b/other.png\n")],
    ["wrong old marker", binaryDiff().replace("/dev/null and", "a/docs/screenshot.png and")],
    ["wrong new marker", binaryDiff().replace("b/docs/screenshot.png differ", "b/other.png differ")],
    ["quoted header", binaryDiff().replace("a/docs/screenshot.png b/docs/screenshot.png", '"a/docs/screenshot.png" "b/docs/screenshot.png"')],
    ["duplicate section", binaryDiff() + binaryDiff()],
    ["conflicting section", binaryDiff() + binaryDiff().replaceAll("b/docs/screenshot.png", "b/other.png")],
    ["marker inside hunk", binaryDiff().replace("Binary files", "@@ -0,0 +1 @@\n+Binary files")],
    ["hunk after marker", binaryDiff() + "@@ -0,0 +1 @@\n+hidden text\n"],
  ];
  for (const [name, diff] of invalidDiffs) {
    it(`does not exclude an image with ${name}`, async () => {
      const fetched = await fetchInput([png()], diff);
      expect(fetched.input.files[0].binaryEvidence).toBeUndefined();
      expect(prepareReviewInput(fetched.input, { maxChars: 1000 }).coverage.files[0].state).toBe("unavailable");
    });
  }

  for (const [name, diff] of [
    ["unchanged old/new prefix", modifiedDiff.replace("bbbbbbb", "aaaaaaa")],
    ["overlapping old/new prefix", modifiedDiff.replace("bbbbbbb", "aaaaaaaa")],
    ["executable", modifiedDiff.replace("100644", "100755")],
    ["missing mode", modifiedDiff.replace(" 100644", "")],
    ["mode-only change", modifiedDiff.replace("index bbbbbbb..aaaaaaa 100644", "old mode 100755\nnew mode 100644")],
    ["additional rename metadata", modifiedDiff.replace("index ", "rename from old.png\nrename to docs/screenshot.png\nindex ")],
  ]) {
    it(`rejects a modified PNG with ${name}`, async () => {
      const fetched = await fetchInput([{ ...png(), status: "modified" }], diff);
      expect(prepareReviewInput(fetched.input, { maxChars: 1000 }).coverage.files[0].state).toBe("unavailable");
    });
  }

  for (const path of ["src/validation.ts", "icon.svg", "photo.gif", "source.png.ts", "../outside.png", "/absolute.png", "docs//empty.png", "docs/./dot.png", "docs/a b.png", 'docs/a"b.png', "docs/a\\b.png", "docs/a\nb.png"]) {
    it(`does not authorize binary exclusion for ${JSON.stringify(path)}`, async () => {
      const fetched = await fetchInput([png(path)], binaryDiff(path));
      const prepared = prepareReviewInput(fetched.input, { maxChars: 1000 });
      expect(prepared.coverage.complete).toBe(false);
      expect(prepared.coverage.files[0].state).toBe("unavailable");
    });
  }

  it("supplies actual text hunks under a PNG filename instead of applying binary policy", async () => {
    const patch = "@@ -0,0 +1 @@\n+This is text, not an image\n";
    const fetched = await fetchInput([{ ...png(), additions: 1, patch }], binaryDiff());
    const prepared = prepareReviewInput(fetched.input, { maxChars: 1000 });
    expect(prepared.coverage.files[0].state).toBe("supplied");
    expect(prepared.coverage.files[0].binaryEvidence).toBeUndefined();
    expect(prepared.diff).toContain("+This is text, not an image");
  });

  it("does not treat a source -diff attribute as permission to exclude missing source", async () => {
    const path = "src/validation.ts";
    const fetched = await fetchInput([png(path)], binaryDiff(path));
    const prepared = prepareReviewInput(fetched.input, { maxChars: 1000, generated: buildGeneratedMatcher("src/** -diff\n") });
    expect(prepared.coverage.files[0].state).toBe("unavailable");
    expect(prepared.coverage.complete).toBe(false);
    expect(reviewCheckResult(prepared.coverage, false, 0).conclusion).toBe("failure");
  });

  const tamperedEvidence: [string, Record<string, unknown>][] = [
    ["policy", { policy: "untrusted" }], ["provider", { provider: "gitlab" }],
    ["head", { headSha: "3".repeat(40) }], ["base", { baseSha: "3".repeat(40) }],
    ["path", { path: "other.png" }], ["change", { change: "modified" }],
    ["blob", { blobSha: "b".repeat(40) }], ["missing raw section", { rawSection: undefined }],
    ["changed raw section", { rawSection: binaryDiff().replace("100644", "100755") }],
    ["missing digest", { rawSectionSha256: undefined }], ["changed digest", { rawSectionSha256: "f".repeat(64) }],
  ];
  for (const [name, changes] of tamperedEvidence) {
    it(`revalidates ${name} evidence at shared preparation`, async () => {
      const fetched = await fetchInput([png()], binaryDiff());
      const file = fetched.input.files[0];
      expect(file.binaryEvidence).toBeDefined();
      file.binaryEvidence = { ...file.binaryEvidence, ...changes } as typeof file.binaryEvidence;
      const prepared = prepareReviewInput(fetched.input, { maxChars: 1000 });
      expect(prepared.coverage.files[0].state).toBe("unavailable");
      expect(prepared.coverage.files[0].binaryEvidence).toBeUndefined();
    });
  }

  const changedBindings: [string, (input: ReviewInput) => void][] = [
    ["unsupported GitLab", input => { input.provider = "gitlab"; }],
    ["unsupported Bitbucket", input => { input.provider = "bitbucket"; }],
    ["missing head", input => { input.headSha = null; }],
    ["missing base", input => { input.baseSha = null; }],
    ["different head", input => { input.headSha = "3".repeat(40); }],
    ["different base", input => { input.baseSha = "3".repeat(40); }],
    ["source path", input => { input.files[0].path = "src/auth.ts"; }],
    ["changed metadata count", input => { input.files[0].additions = 1; }],
    ["retention error", input => { input.files[0].unavailable = "File exceeds retained patch budget"; }],
    ["removed receipt", input => { input.files[0].binaryEvidence = undefined; }],
  ];
  for (const [name, change] of changedBindings) {
    it(`rejects ${name} after provider classification`, async () => {
      const fetched = await fetchInput([png()], binaryDiff());
      change(fetched.input);
      const prepared = prepareReviewInput(fetched.input, { maxChars: 1000 });
      expect(prepared.coverage.files[0].state).toBe("unavailable");
      expect(prepared.coverage.complete).toBe(false);
    });
  }

  it("preserves existing repository policy and retains only verified evidence copies", async () => {
    const fetched = await fetchInput([png()], binaryDiff());
    const prepared = prepareReviewInput(fetched.input, { maxChars: 1000, ignored: parseOctopusIgnore("docs/*.png") });
    expect(prepared.coverage.files[0].reason).toBe("Repository .octopusignore policy");
    const evidence = prepared.coverage.files[0].binaryEvidence;
    expect(evidence).toEqual(fetched.input.files[0].binaryEvidence);
    fetched.input.files[0].binaryEvidence!.rawSectionSha256 = "modified after preparation";
    expect(evidence?.rawSectionSha256).toBe(sha256(binaryDiff()));
  });

  it("retains the revision-drift barrier while fetching binary files", async () => {
    let reads = 0;
    await expect(fetchGitHubReviewInput({
      expectedHead: head, maxPatchChars: 1000, fetchDiff: async () => binaryDiff(),
      readJson: async suffix => suffix ? [png()] : { head: { sha: head }, base: { sha: ++reads === 1 ? base : "3".repeat(40) }, changed_files: 1 },
    })).rejects.toThrow("PR revision changed");
  });
});
