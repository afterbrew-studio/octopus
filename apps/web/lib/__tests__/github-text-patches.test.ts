import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { fetchGitHubReviewInput } from "@/lib/github-review-input";
import { prepareReviewInput } from "@/lib/review-coverage";

const head = "1".repeat(40), base = "2".repeat(40);

function added(content = "<p>Hello</p>\n", path = "public/index.html") {
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}\n`).join("")}${content.endsWith("\n") ? "" : "\\ No newline at end of file\n"}`;
  return {
    file: { filename: path, status: "added", additions: lines.length, deletions: 0, sha },
    patch,
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${sha.slice(0, 7)}\n--- /dev/null\n+++ b/${path}\n${patch}`,
  };
}

async function fetch(files: unknown[], diff: string, maxPatchChars = 200_000) {
  return (await fetchGitHubReviewInput({ expectedHead: head, maxPatchChars,
    fetchDiff: async () => diff,
    readJson: async suffix => suffix ? files : { head: { sha: head }, base: { sha: base }, changed_files: files.length },
  })).input;
}

describe("GitHub missing added text patches", () => {
  it("recovers a complete long-line HTML file missing from the files API", async () => {
    const fixture = added(Array.from({ length: 267 }, (_, i) => `<p>${i === 100 ? "x".repeat(140_000) : i}</p>\n`).join(""));
    const input = await fetch([fixture.file], fixture.diff);
    expect(input.files[0].patch).toBe(fixture.patch);
    const prepared = prepareReviewInput(input, { maxChars: 350_000 });
    expect(prepared.coverage.complete).toBe(true);
    expect(prepared.coverage.files[0]).toMatchObject({ state: "supplied", blobSha: fixture.file.sha });
    expect(prepared.diff).toContain(fixture.patch);
    expect(prepared.coverage.assessment).toBeUndefined(); // Input recovery does not award a score.
  });

  for (const content of ["one line", "one\n\ntwo\n", "Café 🐙\r\n", "+prefix\n-diff\n", "\n"]) {
    it(`preserves exact Git blob bytes for ${JSON.stringify(content)}`, async () => {
      const fixture = added(content);
      const input = await fetch([fixture.file], fixture.diff);
      expect(input.files[0].patch).toBe(fixture.patch);
      expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.complete).toBe(true);
    });
  }

  const metadata: [string, Record<string, unknown>][] = [
    ["missing blob", { sha: undefined }], ["short blob", { sha: "a".repeat(7) }],
    ["wrong blob", { sha: "a".repeat(40) }], ["null blob", { sha: "0".repeat(40) }],
    ["missing additions", { additions: undefined }], ["string additions", { additions: "1" }],
    ["wrong count", { additions: 2 }], ["noninteger count", { additions: 1.5 }],
    ["unsafe count", { additions: Number.MAX_SAFE_INTEGER + 1 }],
    ["deletions", { deletions: 1 }], ["missing deletions", { deletions: undefined }],
    ["modified", { status: "modified" }], ["removed", { status: "removed" }],
    ["renamed", { status: "renamed" }], ["previous path", { previous_filename: "old.html" }],
    ["null patch", { patch: null }], ["empty patch", { patch: "" }], ["malformed patch", { patch: "bad patch" }],
  ];
  for (const [label, change] of metadata) {
    it(`does not replace absent or contradictory evidence: ${label}`, async () => {
      const fixture = added();
      const input = await fetch([{ ...fixture.file, ...change }], fixture.diff);
      expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.files[0].state).toBe("unavailable");
    });
  }

  const fixture = added();
  const invalidDiffs: [string, string][] = [
    ["missing diff", ""], ["missing index", fixture.diff.replace(/^index .*\n/m, "")],
    ["wrong prefix", fixture.diff.replace(/\.\.[0-9a-f]+\n/, "..aaaaaaa\n")],
    ["missing zero old blob", fixture.diff.replace("0000000..", "bbbbbbb..")],
    ["short prefix", fixture.diff.replace(fixture.file.sha.slice(0, 7), fixture.file.sha.slice(0, 6))],
    ["executable", fixture.diff.replace("100644", "100755")],
    ["symlink", fixture.diff.replace("100644", "120000")],
    ["wrong old path", fixture.diff.replace("a/public/index.html b/", "a/old.html b/")],
    ["wrong old marker", fixture.diff.replace("--- /dev/null", "--- a/public/index.html")],
    ["wrong new marker", fixture.diff.replace("+++ b/public/index.html", "+++ b/other.html")],
    ["truncated hunk", fixture.diff.replace("+<p>Hello</p>\n", "")],
    ["missing final newline", fixture.diff.slice(0, -1)],
    ["wrong bytes with matching counts", fixture.diff.replace("<p>Hello</p>", "<p>Other</p>")],
    ["wrong starting coordinate", fixture.diff.replace("+1,1 @@", "+2,1 @@")],
    ["unsafe coordinate", fixture.diff.replace("+1,1 @@", "+9007199254740992,1 @@")],
    ["overlapping hunks", fixture.diff + fixture.patch],
    ["trailing content", fixture.diff + "unexpected\n"],
    ["duplicate section", fixture.diff + fixture.diff],
    ["conflicting old alias", fixture.diff + fixture.diff.replaceAll("b/public/index.html", "b/other.html")],
    ["quoted header elsewhere", fixture.diff + 'diff --git "a/unsafe name" "b/unsafe name"\n'],
  ];
  for (const [label, diff] of invalidDiffs) {
    it(`rejects ${label}`, async () => {
      const input = await fetch([fixture.file], diff);
      expect(input.files[0].patch).toBeUndefined();
      expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.complete).toBe(false);
    });
  }

  for (const path of ["../index.html", "/index.html", "a//index.html", "a/./index.html", "a b.html", 'a"b.html', "a\\b.html"]) {
    it(`leaves an unsupported path unavailable: ${JSON.stringify(path)}`, async () => {
      const data = added("text\n", path);
      const input = await fetch([data.file], data.diff);
      expect(input.files[0].patch).toBeUndefined();
    });
  }

  it("does not recover a NUL-containing blob as text", async () => {
    const data = added("text\0binary\n");
    expect((await fetch([data.file], data.diff)).files[0].patch).toBeUndefined();
  });

  it("keeps present provider patches authoritative even when a different raw patch is available", async () => {
    const input = await fetch([{ ...fixture.file, patch: "@@ -0,0 +1,1 @@\n+API source\n" }], fixture.diff);
    expect(input.files[0].patch).toBe("@@ -0,0 +1,1 @@\n+API source\n");
  });

  it("does not recover a provider patch discarded by the retention budget", async () => {
    const input = await fetch([{ ...fixture.file, patch: "x".repeat(1001) }], fixture.diff, 1000);
    expect(input.files[0]).toMatchObject({ unavailable: "File exceeds retained patch budget" });
    expect(input.files[0].patch).toBeUndefined();
  });

  it("charges recovered patches to the same per-file and cumulative retention allowances", async () => {
    const a = added("x".repeat(60) + "\n", "src/a.ts"), b = added("x".repeat(60) + "\n", "src/b.ts"), c = added("x".repeat(60) + "\n", "src/c.ts");
    const input = await fetch([a.file, { ...b.file, patch: b.patch }, c.file], a.diff + b.diff + c.diff, a.patch.length);
    expect(input.files.map(file => file.patch)).toEqual([a.patch, b.patch, undefined]);
    expect(input.files[2].unavailable).toBe("File exceeds retained patch budget");
    const tooSmall = await fetch([a.file], a.diff, a.patch.length - 1);
    expect(tooSmall.files[0].patch).toBeUndefined();
    expect(tooSmall.files[0].unavailable).toBe("File exceeds retained patch budget");
    const docs = added("docs\n", "README.md");
    expect((await fetch([docs.file], docs.diff, docs.patch.length)).files[0].unavailable).toBe("File exceeds retained patch budget");
  });

  it("still omits recovered source if it cannot fit the review allowance", async () => {
    const input = await fetch([fixture.file], fixture.diff);
    const prepared = prepareReviewInput(input, { maxChars: 1 });
    expect(prepared.coverage.files[0].state).toBe("omitted");
    expect(prepared.coverage.complete).toBe(false);
  });

  it("never converts recovered text into a PNG exclusion", async () => {
    const data = added("actual text\n", "docs/example.png");
    const input = await fetch([data.file], data.diff);
    expect(input.files[0].binaryEvidence).toBeUndefined();
    expect(prepareReviewInput(input, { maxChars: 1000 }).coverage.files[0].state).toBe("supplied");
  });

  it("retains the revision drift barrier", async () => {
    let reads = 0;
    await expect(fetchGitHubReviewInput({ expectedHead: head, maxPatchChars: 1000,
      fetchDiff: async () => fixture.diff,
      readJson: async suffix => suffix ? [fixture.file] : { head: { sha: ++reads === 1 ? head : "3".repeat(40) }, base: { sha: base }, changed_files: 1 },
    })).rejects.toThrow("PR revision changed");
  });
});
