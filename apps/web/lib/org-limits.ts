import { prisma } from "@octopus/db";
import { MAX_OWNED_ORGS_PER_USER } from "@/lib/constants";

export async function canUserCreateOrg(userId: string): Promise<boolean> {
  const count = await prisma.organizationMember.count({
    where: {
      userId,
      role: "owner",
      deletedAt: null,
      organization: { deletedAt: null },
    },
  });
  return count < MAX_OWNED_ORGS_PER_USER;
}

/** Minimal client shape for counting owner memberships — satisfied by both the
 *  Prisma client and a `$transaction` client, so the check can run inside a tx. */
type OrgMemberCounter = {
  organizationMember: {
    count(args: { where: { userId: string; role: string } }): Promise<number>;
  };
};

/**
 * Whether the user has EVER owned an organization, counting soft-deleted ones.
 *
 * The welcome bonus is granted only when this is false, so it can't be farmed
 * by delete-and-recreate: deleting an org only *soft*-deletes the owner
 * membership, and this count omits the `deletedAt` filter, so a returning user
 * no longer looks like a first-time owner. Pass the `$transaction` client at
 * call sites so the eligibility check stays atomic with the org create.
 */
export async function hasEverOwnedOrg(
  client: OrgMemberCounter,
  userId: string,
): Promise<boolean> {
  const count = await client.organizationMember.count({
    where: { userId, role: "owner" },
  });
  return count > 0;
}
