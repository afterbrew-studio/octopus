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
 * The fence is a claim token written when a worker claims the row. Before the
 * irreversible half the worker reserves its claim with a conditional write, so
 * the row cannot be taken between the check and the publication; the terminal
 * write is conditioned on the token as well. The interleaving itself is covered
 * by the review lifecycle harness, which evaluates the real claim query.
 */

describe("the claim fence", () => {
  it("reserves the row while the token matches, conditioning the write on the claim", async () => {
    const updateMany = mock(async () => ({ count: 1 }));
    mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma: { pullRequest: { updateMany } } }));
    const { reserveClaim } = await import("@/lib/claim-fence");
    expect(await reserveClaim("pr_1", "tok-a")).toBe(true);
    const call = updateMany.mock.calls[0] as unknown as [{ where: unknown; data: { updatedAt: Date } }];
    // The token, the status and the refreshed `updatedAt` are the whole fence:
    // drop any one and a lost row is reserved, or a reserved row stays reclaimable.
    expect(call[0].where).toEqual({ id: "pr_1", claimToken: "tok-a", status: "reviewing" });
    expect(call[0].data.updatedAt).toBeInstanceOf(Date);
  });

  it("does not reserve a row another worker re-claimed, reaped or deleted", async () => {
    // A null token (every row predating the fence), a different token, a reaped
    // `failed` row and a vanished row all match nothing, so "unknown" reads as
    // "not mine".
    const updateMany = mock(async () => ({ count: 0 }));
    mock.module("@octopus/db", () => ({ prisma: { pullRequest: { updateMany } } }));
    const { reserveClaim } = await import("@/lib/claim-fence");
    expect(await reserveClaim("pr_1", "tok-a")).toBe(false);
  });
});
