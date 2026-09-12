import { afterEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

const { stuckReviewMs } = await import("@/lib/webhook-shared");

/**
 * A watchdog shorter than the work it supervises does not detect stalls, it
 * manufactures them. At a fixed three minutes it fired while a legitimate
 * strong-tier call was still running and started another review on top, which is
 * how one review became four attempts on rayf #646.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env.GATEWAY_TIMEOUT_MS = saved.GATEWAY_TIMEOUT_MS;
  process.env.STUCK_REVIEW_MS = saved.STUCK_REVIEW_MS;
});

describe("the stuck-review window", () => {
  it("outlives the call it supervises", () => {
    process.env.GATEWAY_TIMEOUT_MS = "600000";
    delete process.env.STUCK_REVIEW_MS;
    expect(stuckReviewMs()).toBeGreaterThan(600_000);
  });

  it("tracks the call ceiling rather than a constant", () => {
    delete process.env.STUCK_REVIEW_MS;
    process.env.GATEWAY_TIMEOUT_MS = "300000";
    const small = stuckReviewMs();
    process.env.GATEWAY_TIMEOUT_MS = "900000";
    expect(stuckReviewMs()).toBeGreaterThan(small);
  });

  it("is never the three minutes that caused the fan-out", () => {
    delete process.env.STUCK_REVIEW_MS;
    delete process.env.GATEWAY_TIMEOUT_MS;
    expect(stuckReviewMs()).toBeGreaterThan(180_000);
  });

  it("takes an explicit override when an operator sets one", () => {
    process.env.STUCK_REVIEW_MS = "45000";
    expect(stuckReviewMs()).toBe(45_000);
  });

  it("ignores a nonsense ceiling rather than trusting it", () => {
    delete process.env.STUCK_REVIEW_MS;
    process.env.GATEWAY_TIMEOUT_MS = "not-a-number";
    expect(stuckReviewMs()).toBeGreaterThan(180_000);
  });
});
