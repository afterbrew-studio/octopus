import { buildGeneratedMatcher } from "@/lib/generated-files";
import { prepareReviewInput } from "@/lib/review-coverage";
import { describe, it, expect, mock } from "bun:test";

mock.module("server-only", () => ({}));

const { classifyDiff, extractChangedPaths, MECHANICAL_MODEL } = await import(
  "@/lib/review-routing"
);

function diffFor(path: string, added = 3): string {
  const plus = Array.from({ length: added }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,${added} @@\n${plus}\n`;
}

describe("extractChangedPaths", () => {
  it("pulls the new-side path from each file header", () => {
    const d = diffFor("src/a.ts") + diffFor("src/b.ts");
    expect(extractChangedPaths(d)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("classifyDiff", () => {
  it("classifies a lockfile-only diff as mechanical", () => {
    expect(classifyDiff(diffFor("bun.lock", 500)).tier).toBe("mechanical");
  });

  it("classifies a docs-only diff as mechanical", () => {
    expect(classifyDiff(diffFor("README.md", 40)).tier).toBe("mechanical");
  });

  it("classifies a tests-only diff as mechanical", () => {
    expect(classifyDiff(diffFor("src/foo.test.ts", 40)).tier).toBe("mechanical");
  });

  it("classifies a tiny single-file source edit as mechanical", () => {
    expect(classifyDiff(diffFor("src/foo.ts", 4)).tier).toBe("mechanical");
  });

  it("classifies a normal multi-file source change as standard", () => {
    const d = diffFor("src/a.ts", 60) + diffFor("src/b.ts", 60);
    expect(classifyDiff(d).tier).toBe("standard");
  });

  it("classifies a schema/migration change as complex (high-risk)", () => {
    const c = classifyDiff(diffFor("packages/db/prisma/schema.prisma", 5));
    expect(c.tier).toBe("complex");
    expect(c.highRisk).toBe(true);
  });

  it("classifies a large diff as complex even without high-risk files", () => {
    expect(classifyDiff(diffFor("src/big.ts", 500)).tier).toBe("complex");
  });

  it("a mixed lockfile + real source change is NOT mechanical", () => {
    const d = diffFor("bun.lock", 300) + diffFor("src/app.ts", 40);
    expect(classifyDiff(d).mechanicalOnly).toBe(false);
    expect(classifyDiff(d).tier).toBe("standard");
  });

  it("counts loc and files", () => {
    const c = classifyDiff(diffFor("src/a.ts", 7));
    expect(c.files).toBe(1);
    expect(c.loc).toBe(7);
  });
});

describe("pricing coverage (never bill $0 on a downshift)", () => {
  it("the mechanical downshift model has fallback pricing", async () => {
    const { fallbackPricedModels } = await import("@/lib/cost");
    expect(fallbackPricedModels()).toContain(MECHANICAL_MODEL);
  });
});

describe("Opus 5 pricing (#opus-5 launch)", () => {
  it("claude-opus-5 has fallback pricing so it never bills $0", async () => {
    const { fallbackPricedModels } = await import("@/lib/cost");
    expect(fallbackPricedModels()).toContain("claude-opus-5");
    expect(fallbackPricedModels()).toContain("qwen3.8-max-0902");
  });

  it("claude-opus-4-8 (replaces Opus 4.6) has fallback pricing", async () => {
    const { fallbackPricedModels } = await import("@/lib/cost");
    expect(fallbackPricedModels()).toContain("claude-opus-4-8");
  });

  it("claude-fable-5 (frontier max tier) has fallback pricing", async () => {
    const { fallbackPricedModels } = await import("@/lib/cost");
    expect(fallbackPricedModels()).toContain("claude-fable-5");
  });
});


describe("coverage-aware model classification", () => {
  it("preserves a complete tiny edit and accounts for omitted source", () => {
    const files = [{ path: "src/example.ts", change: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" }];
    const input = { provider: "github", headSha: "a", baseSha: "b", inventoryComplete: true, expectedFiles: 1, limitations: [], files };
    const full = prepareReviewInput(input, { maxChars: 1000 });
    expect(classifyDiff(full.diff, full.coverage)).toEqual(classifyDiff(full.diff));
    expect(classifyDiff(full.diff, full.coverage)).toMatchObject({ files: 1, loc: 2, tier: "mechanical" });
    const omitted = prepareReviewInput(input, { maxChars: 0 });
    expect(classifyDiff(omitted.diff, omitted.coverage)).toMatchObject({ files: 1, tier: "standard" });
    const mixed = prepareReviewInput({ ...input, expectedFiles: 2, files: [...files, { path: "README.md", change: "added", patch: "@@ -0,0 +1 @@\n+docs\n" }] }, { maxChars: 90 });
    expect(classifyDiff(mixed.diff, mixed.coverage)).toMatchObject({ files: 2, mechanicalOnly: false, tier: "standard" });
  });
});

it("ignores policy-excluded paths while retaining unavailable source in routing", () => {
  const files = [
    { path: "src/example.ts", change: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" },
    { path: "bun.lock", change: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" },
  ];
  const input = { provider: "github", headSha: "a", baseSha: "b", inventoryComplete: true, expectedFiles: 2, limitations: [], files };
  const full = prepareReviewInput(input, { maxChars: 1000, generated: buildGeneratedMatcher() });
  expect(full.coverage.files[1].state).toBe("excluded");
  expect(classifyDiff(full.diff, full.coverage)).toEqual(classifyDiff(full.diff));
  expect(classifyDiff(full.diff, full.coverage)).toMatchObject({ files: 1, loc: 2, tier: "mechanical" });
  const missingSource = prepareReviewInput({ ...input, files: [
    { path: "src/example.ts", change: "modified" },
    { path: "README.md", change: "modified", patch: "@@ -1 +1 @@\n-old\n+new\n" },
  ] }, { maxChars: 1000 });
  expect(classifyDiff(missingSource.diff, missingSource.coverage)).toMatchObject({ files: 2, mechanicalOnly: false, tier: "standard" });
});
