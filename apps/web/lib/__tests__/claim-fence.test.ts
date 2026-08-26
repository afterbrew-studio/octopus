import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * A worker that lost its row must not publish and must not finalise.
 *
 * pg-boss times a handler out with `Promise.race` and aborts a signal nothing in
 * this codebase observes, so the original worker keeps running. Five minutes
 * later the reaper marks the row failed and enqueues a retry. Without a fence
 * both workers post a review and both write a terminal status: two paid reviews,
 * two comments, and a `completed` row whose attempt says `failed`. rayf#124.
 *
 * The fence is a claim token written when a worker claims the row. These assert
 * the two shapes it takes: an advisory read before the irreversible half, and a
 * conditional write that cannot be raced.
 */

describe("the claim fence", () => {
  it("recognises the row as ours while the token matches", async () => {
    const findUnique = mock(async () => ({ claimToken: "tok-a" }));
    mock.module("@octopus/db", () => ({ prisma: { pullRequest: { findUnique } } }));
    const { stillOurs } = await import("@/lib/claim-fence");
    expect(await stillOurs("pr_1", "tok-a")).toBe(true);
  });

  it("recognises a re-claimed row as not ours", async () => {
    const findUnique = mock(async () => ({ claimToken: "tok-b" }));
    mock.module("@octopus/db", () => ({ prisma: { pullRequest: { findUnique } } }));
    const { stillOurs } = await import("@/lib/claim-fence");
    expect(await stillOurs("pr_1", "tok-a")).toBe(false);
  });

  it("treats a row with no token as not ours", async () => {
    // Every row predating the fence has a null token. "Unknown" must read as
    // "not mine": a worker that assumed ownership on a null would be exempt from
    // the fence for exactly the rows that never had one.
    const findUnique = mock(async () => ({ claimToken: null }));
    mock.module("@octopus/db", () => ({ prisma: { pullRequest: { findUnique } } }));
    const { stillOurs } = await import("@/lib/claim-fence");
    expect(await stillOurs("pr_1", "tok-a")).toBe(false);
  });

  it("treats a vanished row as not ours", async () => {
    const findUnique = mock(async () => null);
    mock.module("@octopus/db", () => ({ prisma: { pullRequest: { findUnique } } }));
    const { stillOurs } = await import("@/lib/claim-fence");
    expect(await stillOurs("pr_1", "tok-a")).toBe(false);
  });
});
