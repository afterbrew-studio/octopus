import { describe, it, expect } from "bun:test";
import {
  mayStartReview,
  reviewRefusalMessage,
  type ReviewSource,
} from "@/lib/review-start-policy";

/**
 * ADR-0056 makes Companion the only review-dispatch authority. What that guards
 * against is a review starting on GitHub's schedule: budget spent because a push
 * happened, not because anybody asked. A person adding a review label is the other
 * thing, so `label` is permitted and the automatic path is not.
 *
 * The refusal itself is one function. What these assert is that it refuses the
 * right thing, permits the right thing, and says so in a way nobody mistakes for a
 * permissions problem they could go and fix.
 */

describe("review start policy", () => {
  it("permits the authenticated adapter", () => {
    expect(mayStartReview("adapter")).toBe(true);
  });

  it("refuses the automatic webhook path", () => {
    expect(mayStartReview("webhook")).toBe(false);
  });

  it("permits a label, because a person asked for that one review", () => {
    expect(mayStartReview("label")).toBe(true);
  });

  it("permits a mention, which is the same act with a different gesture", () => {
    expect(mayStartReview("mention")).toBe(true);
  });

  it("refuses anything not on the allow-list, including a future source", () => {
    // The check is an allow-list, not a deny-list. A source added later must be
    // refused until somebody decides otherwise, rather than inheriting permission
    // because nobody remembered to add it to a list of things to block. Deny-listing
    // `webhook` would read identically today and fail exactly here.
    const refused = ["webhook", "cron", "", "ADAPTER", "adapter ", "LABEL", "label ", "Mention"];
    for (const source of refused as unknown as ReviewSource[]) {
      expect(mayStartReview(source)).toBe(false);
    }
  });

  it("names the pull request it refused, so a silent no-op is distinguishable", () => {
    expect(reviewRefusalMessage("webhook", "github pr #42 on afterbrew-studio/rayf")).toContain(
      "github pr #42 on afterbrew-studio/rayf",
    );
  });

  it("does not read as a permissions failure", () => {
    // If this reads as "you lack a role", the next person goes looking for the
    // role that grants it and finds none, having wasted the search.
    const message = reviewRefusalMessage("webhook", "pr #1");
    expect(message).toContain("deployment policy, not a permission");
    expect(message).toContain("cannot be granted, configured or enabled");
  });
});
