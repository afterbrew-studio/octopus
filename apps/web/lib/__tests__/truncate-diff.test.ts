import { describe, it, expect } from "bun:test";
import { truncateDiff, MAX_DIFF_CHARS, TRUNCATION_MARKER } from "@/lib/diff-truncate";

describe("truncateDiff", () => {
  it("returns diffs at or under the cap unchanged", () => {
    const diff = "diff --git a/x b/x\n+hello\n";
    expect(truncateDiff(diff)).toBe(diff);
    // A diff exactly at the cap is not truncated (everyday PRs review in full).
    expect(truncateDiff("y".repeat(MAX_DIFF_CHARS))).not.toContain(TRUNCATION_MARKER);
  });

  it("truncates oversized diffs and marks them (never silent)", () => {
    const big = "x".repeat(MAX_DIFF_CHARS + 100_000);
    const out = truncateDiff(big);
    expect(out.length).toBeLessThan(big.length);
    expect(out).toContain(TRUNCATION_MARKER);
  });
});
