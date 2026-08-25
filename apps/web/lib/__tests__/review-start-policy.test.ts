import { describe, it, expect } from "bun:test";
import {
  ReviewStartRefusedError,
  assertMayStartReview,
  mayStartReview,
  type ReviewSource,
} from "@/lib/review-start-policy";

/**
 * ADR-0056 makes Companion the only review-dispatch authority. A webhook that can
 * start a review is a second one, spending model budget on GitHub's schedule and
 * outside the attempt record that makes a paid review attributable.
 *
 * The refusal itself is one function. What these assert is that it refuses the
 * right thing, permits the right thing, and says so in a way nobody mistakes for a
 * permissions problem they could go and fix.
 */

describe("review start policy", () => {
  it("permits the authenticated adapter", () => {
    expect(mayStartReview("adapter")).toBe(true);
    expect(() => assertMayStartReview("adapter", "pr #1")).not.toThrow();
  });

  it("refuses a webhook", () => {
    expect(mayStartReview("webhook")).toBe(false);
    expect(() => assertMayStartReview("webhook", "pr #1")).toThrow(ReviewStartRefusedError);
  });

  it("refuses anything that is not the adapter, including a future source", () => {
    // The check is an allow-list, not a deny-list. A source added later must be
    // refused until somebody decides otherwise, rather than inheriting permission
    // because nobody remembered to add it to a list of things to block.
    for (const source of ["webhook", "cron", "", "ADAPTER", "adapter "] as unknown as ReviewSource[]) {
      expect(mayStartReview(source)).toBe(false);
    }
  });

  it("names the pull request it refused, so a silent no-op is distinguishable", () => {
    expect(() => assertMayStartReview("webhook", "github pr #42 on afterbrew-studio/rayf")).toThrow(
      /github pr #42 on afterbrew-studio\/rayf/,
    );
  });

  it("does not read as a permissions failure", () => {
    // If this reads as "you lack a role", the next person goes looking for the
    // role that grants it and finds none, having wasted the search.
    try {
      assertMayStartReview("webhook", "pr #1");
      throw new Error("expected a refusal");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("deployment policy, not a permission");
      expect(message).toContain("cannot be granted, configured or enabled");
      expect(err).toBeInstanceOf(ReviewStartRefusedError);
      expect((err as ReviewStartRefusedError).statusCode).toBe(403);
    }
  });
});
