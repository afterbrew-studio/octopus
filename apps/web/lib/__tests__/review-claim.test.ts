import { describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

/**
 * A claim is a fencing token bound to the request it was taken for. Every write a
 * worker makes to the shared row carries the whole identity, and a write that
 * matches nothing is the claim being lost.
 */

const claim = { pullRequestId: "pr_1", claimToken: "tok-a", headSha: "a".repeat(40), reviewRequestVersion: 3 };

async function withCount(count: number) {
  const updateMany = mock(async () => ({ count }));
  mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma: { pullRequest: { updateMany } } }));
  const claimModule = await import("@/lib/review-claim");
  return { updateMany, ...claimModule };
}

describe("the claim fence", () => {
  it("conditions a write on token, head, request version and an owned status", async () => {
    const { updateMany, updateUnderClaim } = await withCount(1);
    expect(await updateUnderClaim(claim, { status: "failed" })).toBe(true);
    const where = (updateMany.mock.calls[0] as unknown as [{ where: { AND: unknown[] } }])[0].where.AND[0];
    // Drop any one and a worker holding a stale token reaches a request it never reviewed.
    expect(where).toEqual({
      id: "pr_1", claimToken: "tok-a", headSha: "a".repeat(40), reviewRequestVersion: 3, status: { in: ["reviewing"] },
    });
  });

  it("treats a write that matched nothing as a lost claim", async () => {
    const { writeUnderClaim, updateUnderClaim, ClaimLostError } = await withCount(0);
    expect(await updateUnderClaim(claim, { status: "failed" })).toBe(false);
    await expect(writeUnderClaim(claim, { status: "failed" })).rejects.toBeInstanceOf(ClaimLostError);
  });

  it("reserves by touching updatedAt under the same condition", async () => {
    const { updateMany, reserveClaim } = await withCount(1);
    expect(await reserveClaim(claim)).toBe(true);
    const [{ data }] = updateMany.mock.calls[0] as unknown as [{ data: { updatedAt: Date } }];
    expect(data.updatedAt).toBeInstanceOf(Date);
  });
});
