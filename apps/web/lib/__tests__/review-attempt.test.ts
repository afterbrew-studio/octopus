import { describe, it, expect } from "bun:test";
import { resolveReviewConfig } from "@/lib/review-attempt";
import type { ReviewConfig } from "@/lib/review-helpers";

/**
 * rayf P-0007 C3: "configuration changes between enqueue and execution do not
 * change the attempt."
 *
 * The property under test is that a snapshot BEATS live configuration. So every
 * case below makes the two differ -- a test where they agree would pass whichever
 * one the code picked.
 */

const live = { model: "live-model", maxFindings: 10 } as unknown as ReviewConfig;
const frozen = { model: "frozen-model", maxFindings: 3 };

describe("resolveReviewConfig", () => {
  it("uses the snapshot, not the live config", () => {
    const got = resolveReviewConfig({ configSnapshot: frozen }, live);
    expect(got).toEqual(frozen as unknown as ReviewConfig);
    // Stated separately: the point is not that it equals the snapshot, it is that
    // it does NOT equal what is configured now.
    expect(got).not.toEqual(live);
  });

  it("a change to live config after the snapshot cannot reach the review", () => {
    const attempt = { configSnapshot: { model: "approved" } };
    let current = { model: "approved" } as unknown as ReviewConfig;
    // Somebody edits the org's default between enqueue and execution.
    current = { model: "swapped-underneath" } as unknown as ReviewConfig;
    expect(resolveReviewConfig(attempt, current)).toEqual({ model: "approved" } as unknown as ReviewConfig);
  });

  it("falls back to live config only when there is no attempt", () => {
    // Jobs enqueued before attempts existed are still in the queue and were
    // enqueued under the old behaviour. Refusing them would strand real work.
    expect(resolveReviewConfig(null, live)).toEqual(live);
    expect(resolveReviewConfig(undefined, live)).toEqual(live);
  });

  it("a malformed snapshot does NOT fall back to live config", () => {
    // Falling back here would silently restore the behaviour this exists to
    // remove, and it would do it exactly when the record is already suspect.
    for (const bad of [null, "a string", 42, ["an", "array"], true]) {
      const got = resolveReviewConfig({ configSnapshot: bad }, live);
      expect(got).not.toEqual(live);
      expect(got).toEqual({} as ReviewConfig);
    }
  });

  it("an empty snapshot is honoured, not treated as missing", () => {
    // `{}` is a real decision -- every default -- and must not be confused with
    // "no snapshot", which is the one case that legitimately falls back.
    expect(resolveReviewConfig({ configSnapshot: {} }, live)).toEqual({} as ReviewConfig);
  });
});
