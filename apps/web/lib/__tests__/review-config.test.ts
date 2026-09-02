import { describe, it, expect } from "bun:test";
import {
  parseReviewConfig,
  labelAsksForReview,
  modelForLabels,
  MAX_REVIEW_LABELS,
} from "../review-config-shared";

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

describe("parseReviewConfig models", () => {
  it("reads a label-to-model map", () => {
    const c = parseReviewConfig('{"labels":["review:octopus"],"models":{"complexity:strong":"opencode:glm-5.3"}}');
    expect(c.models).toEqual({ "complexity:strong": "opencode:glm-5.3" });
  });

  it("has no models when the key is absent, so nothing overrides by accident", () => {
    expect(parseReviewConfig('{"labels":["a"]}').models).toEqual({});
  });

  it("drops a malformed entry rather than losing the whole map", () => {
    // A typo in one mapping must not cost the repository the others, and must not throw:
    // the failure direction is "no override", which is where the repository already was.
    const c = parseReviewConfig(
      '{"models":{"good":"acp:MiniMax-M3","bad":42,"":"x","blank":"  "}}',
    );
    expect(c.models).toEqual({ good: "acp:MiniMax-M3" });
  });

  it("still parses models when labels is malformed, and the reverse", () => {
    expect(parseReviewConfig('{"labels":"nope","models":{"a":"m"}}').models).toEqual({ a: "m" });
    expect(parseReviewConfig('{"labels":["x"],"models":[]}').labels).toEqual(["x"]);
  });

  it("bounds how many mappings one repository may configure", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`l${i}`, "m"]));
    expect(Object.keys(parseReviewConfig(JSON.stringify({ models: many })).models).length).toBe(20);
  });
});

describe("modelForLabels", () => {
  const config = parseReviewConfig(
    '{"models":{"complexity:strong":"opencode:glm-5.3","complexity:tiny":"opencode:glm-5.3-flash"}}',
  );

  it("returns the model a present label asks for", () => {
    expect(modelForLabels(config, ["P2", "complexity:strong"])).toBe("opencode:glm-5.3");
  });

  it("returns null when no label maps, so the repository keeps its usual model", () => {
    expect(modelForLabels(config, ["P2", "area:review"])).toBeNull();
  });

  it("is deterministic when a pull request carries two mapped labels", () => {
    // Config order decides, not GitHub's label order. Otherwise the cost of a review
    // would depend on which label happened to be listed first in a webhook payload.
    const both = ["complexity:tiny", "complexity:strong"];
    expect(modelForLabels(config, both)).toBe("opencode:glm-5.3");
    expect(modelForLabels(config, [...both].reverse())).toBe("opencode:glm-5.3");
  });

  it("ignores surrounding whitespace on a label", () => {
    expect(modelForLabels(config, ["  complexity:strong  "])).toBe("opencode:glm-5.3");
  });
});
