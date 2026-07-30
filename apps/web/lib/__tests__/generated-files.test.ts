import { describe, it, expect } from "bun:test";
import {
  buildGeneratedMatcher,
  splitDiffByIgnore,
  parseGitattributesGenerated,
} from "@/lib/generated-files";

function section(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-x\n+y\n`;
}

describe("splitDiffByIgnore (default generated patterns)", () => {
  it("excludes generated files but keeps hand-written ones", () => {
    const diff =
      section("packages/db/drizzle/meta/0007_snapshot.json") +
      section("bun.lock") +
      section("src/__snapshots__/foo.test.ts.snap") +
      section("packages/shared/src/constants.ts");
    const { kept, skipped } = splitDiffByIgnore(diff, buildGeneratedMatcher());

    expect(skipped).toContain("packages/db/drizzle/meta/0007_snapshot.json");
    expect(skipped).toContain("bun.lock");
    expect(skipped).toContain("src/__snapshots__/foo.test.ts.snap");
    expect(kept).toContain("packages/shared/src/constants.ts");
    expect(kept).not.toContain("drizzle/meta");
  });
});

describe("parseGitattributesGenerated", () => {
  it("picks up linguist-generated / -diff markers and emits negations for =false", () => {
    const content = [
      "src/gen/*.ts linguist-generated=true",
      "docs/api.md -diff",
      "# a comment",
      "src/real.ts text",
      "vendored/keep.ts linguist-generated=false",
    ].join("\n");
    const pats = parseGitattributesGenerated(content);
    expect(pats).toEqual(["src/gen/*.ts", "docs/api.md", "!vendored/keep.ts"]);
  });

  it("=false re-includes a file that a default pattern would exclude", () => {
    const diff = section("keep.snap") + section("other.snap");
    // Defaults exclude *.snap; the repo un-marks keep.snap → it stays in review.
    const ig = buildGeneratedMatcher("keep.snap linguist-generated=false");
    const { kept, skipped } = splitDiffByIgnore(diff, ig);
    expect(kept).toContain("keep.snap");
    expect(skipped).toContain("other.snap");
  });

  it("a .gitattributes-marked file is excluded on top of defaults", () => {
    const diff = section("src/gen/client.ts") + section("src/app.ts");
    const ig = buildGeneratedMatcher("src/gen/*.ts linguist-generated");
    const { kept, skipped } = splitDiffByIgnore(diff, ig);
    expect(skipped).toContain("src/gen/client.ts");
    expect(kept).toContain("src/app.ts");
  });
});
