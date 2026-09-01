import { describe, it, expect } from "bun:test";
import { parseReviewConfig, labelAsksForReview, MAX_REVIEW_LABELS } from "../review-config-shared";

describe("parseReviewConfig", () => {
  it("reads the labels a repository configured", () => {
    expect(parseReviewConfig('{"labels":["review:octopus"]}').labels).toEqual(["review:octopus"]);
  });

  it("treats a missing file as no trigger", () => {
    // A repository that has never heard of this file keeps working exactly as before.
    expect(parseReviewConfig(null).labels).toEqual([]);
  });

  it("treats a malformed file as no trigger rather than throwing", () => {
    // The failure direction matters: a config nobody can parse must not take the webhook
    // down, and must not review everything either.
    expect(parseReviewConfig("{ not json").labels).toEqual([]);
    expect(parseReviewConfig("[]").labels).toEqual([]);
    expect(parseReviewConfig('{"labels":"review:octopus"}').labels).toEqual([]);
  });

  it("drops entries that could never match a real label", () => {
    expect(parseReviewConfig('{"labels":["  ", 7, "review:octopus", "review:octopus"]}').labels)
      .toEqual(["review:octopus"]);
  });

  it("bounds how many labels one repository may configure", () => {
    const many = Array.from({ length: 40 }, (_, i) => `label-${i}`);
    expect(parseReviewConfig(JSON.stringify({ labels: many })).labels).toHaveLength(MAX_REVIEW_LABELS);
  });
});

describe("labelAsksForReview", () => {
  it("matches a configured label", () => {
    expect(labelAsksForReview({ labels: ["review:octopus"] }, "review:octopus")).toBe(true);
  });

  it("does not match a label that merely contains a configured one", () => {
    // `not-review:octopus` reads as its own negation. Substring matching here would let an
    // unrelated label spend a metered review.
    expect(labelAsksForReview({ labels: ["review:octopus"] }, "not-review:octopus")).toBe(false);
    expect(labelAsksForReview({ labels: ["review:octopus"] }, "review:octopus-disabled")).toBe(false);
  });

  it("matches nothing when no config exists", () => {
    expect(labelAsksForReview({ labels: [] }, "review:octopus")).toBe(false);
  });
});
