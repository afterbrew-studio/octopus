import { describe, expect, it } from "bun:test";
import { hasEverOwnedOrg } from "@/lib/org-limits";

// Regression guard for the welcome-credit farming leak: the bonus is once per
// user ever, so eligibility must count owner memberships INCLUDING soft-deleted
// ones. If the count ever regains a `deletedAt` filter, delete-and-recreate
// re-grants the bonus and this test fails.
describe("hasEverOwnedOrg", () => {
  function counterReturning(count: number) {
    let seenWhere: Record<string, unknown> | undefined;
    const client = {
      organizationMember: {
        count: (args: { where: { userId: string; role: string } }) => {
          seenWhere = args.where;
          return Promise.resolve(count);
        },
      },
    };
    return { client, where: () => seenWhere };
  }

  it("is false for a user who has never owned an org", async () => {
    const { client } = counterReturning(0);
    expect(await hasEverOwnedOrg(client, "u1")).toBe(false);
  });

  it("is true when a soft-deleted owner membership exists (delete-recreate can't refarm)", async () => {
    const { client } = counterReturning(1);
    expect(await hasEverOwnedOrg(client, "u1")).toBe(true);
  });

  it("counts owner memberships without a deletedAt filter", async () => {
    const { client, where } = counterReturning(0);
    await hasEverOwnedOrg(client, "u1");
    expect(where()).toEqual({ userId: "u1", role: "owner" });
    expect(where()).not.toHaveProperty("deletedAt");
  });
});
