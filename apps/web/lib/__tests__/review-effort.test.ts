import { describe, it, expect, mock, beforeEach } from "bun:test";

mock.module("server-only", () => ({}));

// Mutable fixtures the mocked prisma reads from — each test sets these.
let orgRow: { reviewEffort: string | null } | null = null;
let sysRow: { defaultReviewEffort: string | null } | null = null;

mock.module("@octopus/db", () => ({
  prisma: {
    organization: { findUnique: () => Promise.resolve(orgRow) },
    systemConfig: { findUnique: () => Promise.resolve(sysRow) },
  },
}));

const { getReviewEffort } = await import("@/lib/review-effort");

beforeEach(() => {
  orgRow = null;
  sysRow = null;
});

describe("getReviewEffort", () => {
  it("org override wins over the platform default", async () => {
    orgRow = { reviewEffort: "high" };
    sysRow = { defaultReviewEffort: "low" };
    expect(await getReviewEffort("org1")).toBe("high");
  });

  it("falls back to the platform default when the org has no override", async () => {
    orgRow = { reviewEffort: null };
    sysRow = { defaultReviewEffort: "xhigh" };
    expect(await getReviewEffort("org1")).toBe("xhigh");
  });

  it("returns undefined when neither is set (provider uses env/built-in default)", async () => {
    orgRow = { reviewEffort: null };
    sysRow = null;
    expect(await getReviewEffort("org1")).toBeUndefined();
  });

  it("ignores an invalid stored value and falls through", async () => {
    orgRow = { reviewEffort: "bogus" };
    sysRow = { defaultReviewEffort: "medium" };
    expect(await getReviewEffort("org1")).toBe("medium");
  });
});
