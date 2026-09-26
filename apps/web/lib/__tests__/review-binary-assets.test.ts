import { describe, expect, it } from "bun:test";
import { fetchGitHubReviewInput } from "@/lib/github-review-input";
import { createBinaryAssetEvidence, createBinaryPngEvidence, indexGitHubBinaryPngSections, indexGitHubBinarySections, validateBinaryAssetEvidence, validateBinaryPngEvidence, type BinaryAssetEvidence, type BinaryPngEvidence } from "@/lib/review-binary-assets";
import { applyReviewCoverage, coverageCounts, prepareReviewInput, reviewCheckResult, sha256, type ReviewFileInput } from "@/lib/review-coverage";
import { recordNoModelAssessment } from "@/lib/review-assessment";
import { containExcludedInputClaims, parseReviewFindingsSet } from "@/lib/review-evidence";
import { buildGeneratedMatcher } from "@/lib/generated-files";

const head = "1".repeat(40), base = "2".repeat(40), blob = "a".repeat(40);
const revision = { provider: "github", headSha: head, baseSha: base };
const formats = [["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["ttf", "font"], ["woff2", "font"], ["zip", "archive"]] as const;
const file = (path: string, change = "added"): ReviewFileInput => ({ path, change, additions: 0, deletions: 0, blobSha: blob });
const declaration = (path: string, change = "added") => `diff --git a/${path} b/${path}\n${change === "added" ? "new file mode 100644\nindex 0000000..aaaaaaa" : "index bbbbbbb..aaaaaaa 100644"}\nBinary files ${change === "added" ? "/dev/null" : `a/${path}`} and b/${path} differ\n`;
const metadata = (path: string, status = "added") => ({ filename: path, status, additions: 0, deletions: 0, sha: blob });
async function acquire(files: unknown[], rawDiff: string, maxPatchChars = 10_000) {
  return (await fetchGitHubReviewInput({
    expectedHead: head, maxPatchChars, fetchDiff: async () => rawDiff,
    readJson: async suffix => suffix ? files : { head: { sha: head }, base: { sha: base }, changed_files: files.length },
  })).input;
}

describe("versioned binary asset coverage", () => {
  for (const [extension, assetKind] of formats) {
    for (const change of ["added", "modified"]) {
      it(`excludes declared ${change} ${extension} with a revision-bound ${assetKind} receipt`, async () => {
        const path = `assets/Example.${extension.toUpperCase()}`;
        const rawSection = declaration(path, change);
        const input = await acquire([metadata(path, change)], rawSection);
        const expected = { policy: "github-binary-assets-v2", assetKind, ...revision, path, change, blobSha: blob, rawSection, rawSectionSha256: sha256(rawSection) };
        expect(input.files[0].binaryEvidence).toEqual(expected);
        const restored = JSON.parse(JSON.stringify(input));
        const prepared = prepareReviewInput(restored, { maxChars: 0 });
        expect(prepared.coverage.files[0]).toMatchObject({
          state: "excluded", binaryEvidence: expected, suppliedChars: 0, suppliedSha256: null, hunks: [],
          reason: `Declared binary ${assetKind} policy (github-binary-assets-v2); content not reviewed`,
        });
        expect(prepared.coverage.complete).toBe(true);
        expect(prepared.diff).toBe("");
        expect(reviewCheckResult(prepared.coverage, false, 0).conclusion).toBe("failure");
      });
    }

    it(`supplies ${extension} text even alongside a binary declaration`, async () => {
      const path = `assets/source.${extension}`;
      const patch = "@@ -0,0 +1 @@\n+export const content = 'text';\n";
      const input = await acquire([{ ...metadata(path), additions: 1, patch }], declaration(path));
      const prepared = prepareReviewInput(input, { maxChars: 1000 });
      expect(prepared.coverage.files[0]).toMatchObject({ state: "supplied", suppliedChars: prepared.diff.length });
      expect(prepared.coverage.files[0].binaryEvidence).toBeUndefined();
      expect(prepared.diff).toContain(patch);
    });

    for (const [name, patch] of [["empty", ""], ["malformed", "not a patch"], ["null", null], ["retention-discarded", "x".repeat(101)]] as const) {
      it(`does not exclude ${extension} with a present ${name} API patch`, async () => {
        const path = `assets/content.${extension}`;
        const input = await acquire([{ ...metadata(path), patch }], declaration(path), 100);
        expect(input.files[0].binaryEvidence).toBeUndefined();
        const prepared = prepareReviewInput(input, { maxChars: 1000 });
        expect(prepared.coverage.files[0].state).toBe("unavailable");
        expect(prepared.coverage.complete).toBe(false);
      });
    }
  }

  it("requires every text hunk even when all supported binary classes qualify", async () => {
    const paths = formats.map(([extension]) => `assets/file.${extension}`);
    const patch = "@@ -0,0 +1 @@\n+export const validate = () => true;\n";
    const input = await acquire([
      ...paths.map(path => metadata(path)),
      { filename: "src/validate.ts", status: "added", additions: 1, deletions: 0, patch },
    ], paths.map(path => declaration(path)).join(""));
    const prepared = prepareReviewInput(input, { maxChars: 0 });
    expect(coverageCounts(prepared.coverage)).toEqual({ total: 7, supplied: 0, partial: 0, omitted: 1, unavailable: 0, excluded: 6 });
    recordNoModelAssessment(prepared.coverage);
    expect(prepared.coverage.assessment?.state).toBe("incomplete");
    expect(reviewCheckResult(prepared.coverage, false, 0).conclusion).toBe("failure");
    expect(applyReviewCoverage("Overall 5/5", prepared.coverage, "mixed")).not.toContain("5/5");
  });

  it("records binary-only input as no-model without scoring uninspected content", async () => {
    const paths = formats.map(([extension]) => `assets/file.${extension}`);
    const input = await acquire(paths.map(path => metadata(path)), paths.map(path => declaration(path)).join(""));
    const prepared = prepareReviewInput(input, { maxChars: 0 });
    recordNoModelAssessment(prepared.coverage);
    expect(prepared.coverage.assessment).toMatchObject({ state: "not-required", model: null, requests: [], completion: null, responseSha256: null });
    expect(reviewCheckResult(prepared.coverage, false, 0).title).toBe("No eligible changes under repository policy");
    const report = applyReviewCoverage("Overall 5/5", prepared.coverage, "binary-only");
    expect(report).not.toMatch(/[1-5]\/5/);
    expect(report).toContain("excluded files were not reviewed");
    expect(report).toContain("Declared binary archive policy");
  });

  it("recognizes a declaration without claiming media validation or treating source -diff as an exclusion", async () => {
    const paths = ["assets/document.jpg", "src/import.ts"];
    const input = await acquire(paths.map(path => metadata(path)), paths.map(path => declaration(path)).join(""));
    const prepared = prepareReviewInput(input, { maxChars: 1000, generated: buildGeneratedMatcher("* -diff\n") });
    expect(prepared.coverage.files[0].state).toBe("excluded");
    expect(prepared.coverage.files[1].state).toBe("unavailable");
    expect(prepared.coverage.complete).toBe(false);
  });

  for (const path of ["assets/file.woff", "assets/file.otf", "assets/file.tar", "assets/file.gz", "assets/file.svg", "assets/file.webp", "assets/file.zip.ts", "assets/file.zip/child", "../file.zip", "/file.zip", "a//file.zip", "a/./file.zip", "a/../file.zip", "a/file space.zip", "a/file\0.zip", "a/file\n.zip", "a/file\\.zip", 'a/file".zip', ".zip", "a".repeat(4093) + ".zip"]) {
    it(`rejects an unsupported or unsafe path ${JSON.stringify(path.slice(0, 70))}`, async () => {
      const input = await acquire([metadata(path)], declaration(path));
      expect(input.files[0].binaryEvidence).toBeUndefined();
      expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.files[0].state).toBe("unavailable");
    });
  }

  for (const [extension] of formats.filter(([extension]) => extension !== "png")) {
    for (const [name, change] of [
      ["nonzero counts", { additions: 1 }], ["missing counts", { deletions: undefined }],
      ["wrong blob", { sha: "b".repeat(40) }], ["short blob", { sha: "aaaaaaa" }],
      ["rename", { status: "renamed", previous_filename: "old.zip" }],
      ["copy", { status: "copied" }], ["delete", { status: "removed" }], ["type change", { status: "changed" }],
    ] as const) {
      it(`rejects ${extension} metadata with ${name}`, async () => {
        const path = `assets/file.${extension}`;
        const input = await acquire([{ ...metadata(path), ...change }], declaration(path));
        expect(input.files[0].binaryEvidence).toBeUndefined();
        expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.complete).toBe(false);
      });
    }
    for (const [name, transform] of [
      ["symlink", (raw: string) => raw.replace("100644", "120000")],
      ["executable", (raw: string) => raw.replace("100644", "100755")],
      ["submodule", (raw: string) => raw.replace("100644", "160000")],
      ["duplicate", (raw: string) => raw + raw],
      ["old-path alias", (raw: string) => raw + raw.replaceAll(" b/assets/", " b/other/")],
      ["quoted alias", (raw: string) => raw + 'diff --git "a/other" "b/other"\n'],
      ["hunk marker", (raw: string) => raw.replace("Binary files", "@@ -0,0 +1 @@\n+Binary files")],
      ["truncated declaration", (raw: string) => raw.slice(0, -3)],
    ] as const) {
      it(`rejects ${extension} declarations with ${name}`, async () => {
        const path = `assets/file.${extension}`;
        const input = await acquire([metadata(path)], transform(declaration(path)));
        expect(input.files[0].binaryEvidence).toBeUndefined();
        expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.files[0].state).toBe("unavailable");
      });
    }
  }
});

describe("binary receipt version compatibility", () => {
  const path = "docs/screenshot.png";
  const rawSection = declaration(path);
  const legacy: BinaryPngEvidence = {
    policy: "github-binary-png-v1", provider: "github", headSha: head, baseSha: base,
    path, change: "added", blobSha: blob, rawSection, rawSectionSha256: sha256(rawSection),
  };

  it("round-trips v1 without adding fields, changing its reason or upgrading its policy", () => {
    const original = JSON.stringify(legacy);
    const restored = JSON.parse(original);
    expect(JSON.stringify(validateBinaryAssetEvidence(file(path), revision, restored))).toBe(original);
    expect(JSON.stringify(validateBinaryPngEvidence(file(path), revision, restored))).toBe(original);
    expect(createBinaryPngEvidence(file(path), revision, indexGitHubBinaryPngSections(rawSection).get(path))).toEqual(legacy);
    const prepared = prepareReviewInput({ ...revision, inventoryComplete: true, expectedFiles: 1, limitations: [], files: [{ ...file(path), binaryEvidence: restored }] }, { maxChars: 0 });
    expect(prepared.coverage.files[0].binaryEvidence).toEqual(legacy);
    expect(prepared.coverage.files[0].reason).toBe("Declared binary PNG policy (github-binary-png-v1); image content not reviewed");
    expect(JSON.stringify(restored)).toBe(original);
  });

  it("does not expand the historical v1 scope to other supported assets", () => {
    for (const [extension] of formats.filter(([extension]) => extension !== "png")) {
      const nextPath = `assets/file.${extension}`;
      const nextRaw = declaration(nextPath);
      const forged: BinaryPngEvidence = { ...legacy, path: nextPath, rawSection: nextRaw, rawSectionSha256: sha256(nextRaw) };
      expect(indexGitHubBinaryPngSections(nextRaw).size).toBe(0);
      expect(validateBinaryAssetEvidence(file(nextPath), revision, forged)).toBeUndefined();
      expect(createBinaryPngEvidence(file(nextPath), revision, indexGitHubBinarySections(nextRaw).get(nextPath))).toBeUndefined();
    }
  });

  it("does not upgrade a v1 receipt by changing only its policy tag", () => {
    const renamed = { ...legacy, policy: "github-binary-assets-v2" } as BinaryAssetEvidence;
    expect(validateBinaryAssetEvidence(file(path), revision, renamed)).toBeUndefined();
  });

  for (const [name, changes] of [
    ["kind", { assetKind: "image" }], ["missing kind", { assetKind: undefined }],
    ["unknown policy", { policy: "github-binary-assets-v3" }], ["downgraded policy", { policy: "github-binary-png-v1" }],
    ["head", { headSha: "3".repeat(40) }], ["base", { baseSha: "3".repeat(40) }],
    ["provider", { provider: "gitlab" }], ["blob", { blobSha: "b".repeat(40) }],
    ["path", { path: "other.zip" }], ["change", { change: "modified" }],
    ["digest", { rawSectionSha256: "f".repeat(64) }], ["raw section", { rawSection: undefined }],
    ["unexpected field", { contentReviewed: true }],
  ] as const) {
    it(`rejects v2 receipt tampering: ${name}`, () => {
      const zip = "assets/file.zip";
      const evidence = createBinaryAssetEvidence(file(zip), revision, indexGitHubBinarySections(declaration(zip)).get(zip));
      expect(evidence?.assetKind).toBe("archive");
      const restored = JSON.parse(JSON.stringify({ ...evidence, ...changes }));
      expect(validateBinaryAssetEvidence(file(zip), revision, restored)).toBeUndefined();
      const prepared = prepareReviewInput({ ...revision, inventoryComplete: true, expectedFiles: 1, limitations: [], files: [{ ...file(zip), binaryEvidence: restored }] }, { maxChars: 1000 });
      expect(prepared.coverage.files[0].state).toBe("unavailable");
    });
  }
});

describe("excluded archives and supplied source findings", () => {
  it("withholds an unsupported archive absence claim and retains the supplied extraction-code finding", async () => {
    const archive = "fixtures/import.zip";
    const patch = "@@ -0,0 +1,2 @@\n+for (const entry of archive.entries())\n+  writeFileSync(join(destination, entry.path), entry.content);\n";
    const input = await acquire([metadata(archive), { filename: "src/extract.ts", status: "added", additions: 2, deletions: 0, patch }], declaration(archive));
    const prepared = prepareReviewInput(input, { maxChars: 1000 });
    expect(prepared.coverage.files.map(file => file.state)).toEqual(["excluded", "supplied"]);
    const common = { severity: "🟠", category: "Security", filePath: "src/extract.ts", startLine: 2, endLine: 2, confidence: 95, suggestion: "Validate paths before extraction.", fixPrompt: "" };
    const grounded = { ...common, title: "Constrain extraction paths", description: `The supplied extraction loop processes ${archive} using entry.path directly in writeFileSync; an entry path can escape destination.` };
    const unseen = { ...common, title: "Include the archive", description: `${archive} is missing from the repository.` };
    const report = (findings: object[]) => `## 🐙 Octopus Review\n\n### Score\n| **Overall** | **2/5** | Extraction |\n\n<!-- OCTOPUS_FINDINGS_START -->\n${JSON.stringify(findings)}\n<!-- OCTOPUS_FINDINGS_END -->`;
    const groundedOnly = report([grounded]);
    expect(containExcludedInputClaims(groundedOnly, prepared.coverage).body).toBe(groundedOnly);
    const contained = containExcludedInputClaims(report([unseen, grounded]), prepared.coverage);
    expect(contained.paths).toEqual([archive]);
    expect(contained.rejectedFindings).toBe(1);
    expect(parseReviewFindingsSet(contained.body)).toEqual([grounded]);
    expect(contained.body).not.toMatch(/[1-5]\/5/);
    expect(prepared.coverage.complete).toBe(true);
  });
});
