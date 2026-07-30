import { describe, it, expect, mock } from "bun:test";

// github.ts pulls in server-only (via github-app-config) — stub before import.
mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ prisma: {} }));

const { truncateDiff } = await import("@/lib/github");

describe("truncateDiff", () => {
  it("returns small diffs unchanged", () => {
    const diff = "diff --git a/x b/x\n+hello\n";
    expect(truncateDiff(diff)).toBe(diff);
  });

  it("truncates oversized diffs and marks them (never silent)", () => {
    const big = "x".repeat(400_000);
    const out = truncateDiff(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain("[... diff truncated");
    // The default cap (300k) is well above the old 30k, so a 300k diff is NOT
    // truncated — everyday PRs now review in full.
    expect(truncateDiff("y".repeat(300_000)).includes("[... diff truncated")).toBe(false);
  });
});
