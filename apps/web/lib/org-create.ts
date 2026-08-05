import { prisma } from "@octopus/db";
import { toBaseSlug, randomSlugSuffix } from "@/lib/slug";
import { canUserCreateOrg, hasEverOwnedOrg } from "@/lib/org-limits";
import { assessWelcomeCredit, logWelcomeOutcome } from "@/lib/welcome-credit";
import { MAX_OWNED_ORGS_PER_USER, WELCOME_FREE_CREDITS } from "@/lib/constants";

/**
 * Creates an organization for a user. Pure DB operation — no cookie setting,
 * no auth check (callers are responsible).
 *
 * Why this lives in /lib instead of complete-profile/actions.ts:
 * Next.js treats EVERY export from a `"use server"` module as a publicly
 * invokable server action — a route reachable from any client that obtains
 * its action ID, with no session check beyond what the function performs
 * itself. This function takes `userId` as a parameter, so exporting it from
 * a "use server" module exposed an unauthenticated endpoint that any caller
 * could use to create owner-organizations for arbitrary user IDs (e.g. to
 * grief victims by exhausting their MAX_OWNED_ORGS_PER_USER cap).
 *
 * Keeping it in a plain server lib makes it importable from server-side
 * code (Server Components, server actions, route handlers) without being
 * routable on its own.
 */
export async function createOrgForUser(userId: string, userName: string) {
  const allowed = await canUserCreateOrg(userId);
  if (!allowed) {
    throw new Error(`Organization limit reached (max ${MAX_OWNED_ORGS_PER_USER}).`);
  }

  const firstName = userName.split(" ")[0];
  const orgName = `${firstName}'s Organization`;
  const baseSlug = toBaseSlug(orgName);

  // Generate unique slug with random suffix (checks all orgs including soft-deleted)
  let slug = `${baseSlug}-${randomSlugSuffix()}`;
  for (let i = 0; i < 10; i++) {
    const existing = await prisma.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!existing) break;
    slug = `${baseSlug}-${randomSlugSuffix()}`;
  }

  // Assess welcome-bonus risk before the tx (reads only); the tx confirms
  // first-org atomically.
  const welcome = await assessWelcomeCredit(userId);

  // Re-check limit and create atomically to prevent TOCTOU race
  const created = await prisma.$transaction(async (tx) => {
    const ownedCount = await tx.organizationMember.count({
      where: { userId, role: "owner", deletedAt: null, organization: { deletedAt: null } },
    });
    if (ownedCount >= MAX_OWNED_ORGS_PER_USER) {
      throw new Error(`Organization limit reached (max ${MAX_OWNED_ORGS_PER_USER}).`);
    }

    // First org = bonus not yet granted (leak-proof stamp) AND never owned an
    // org (soft-delete-safe). `ownedCount` above is active-only (drives the cap).
    const firstOrg = welcome.eligible && !(await hasEverOwnedOrg(tx, userId));

    // Consume the one-time bonus on the first org: stamp welcomeGrantedAt
    // exactly once (updateMany where null → only one tx wins, so concurrent
    // creates can't double-grant). A WITHHELD first org still consumes the
    // bonus, so it can't be retried after an org hard-delete. Credits are added
    // only when the claim wins AND the risk score clears.
    let grantBonus = false;
    if (firstOrg) {
      const claim = await tx.user.updateMany({
        where: { id: userId, welcomeGrantedAt: null },
        data: { welcomeGrantedAt: new Date() },
      });
      grantBonus = claim.count === 1 && welcome.grant;
    }

    const org = await tx.organization.create({
      data: {
        name: orgName,
        slug,
        members: {
          create: {
            userId,
            role: "owner",
          },
        },
        ...(firstOrg && {
          welcomeRiskScore: welcome.score,
          welcomeRiskReason: welcome.reason,
        }),
        ...(grantBonus && {
          freeCreditBalance: WELCOME_FREE_CREDITS,
          creditTransactions: {
            create: {
              amount: WELCOME_FREE_CREDITS,
              type: "free_credit",
              description: `Welcome bonus — $${WELCOME_FREE_CREDITS} free credits`,
              balanceAfter: WELCOME_FREE_CREDITS,
            },
          },
        }),
      },
    });
    return { org, firstOrg, granted: grantBonus };
  });
  const org = created.org;

  // Surface a silently-withheld (or race-lost) welcome bonus in the logs.
  logWelcomeOutcome({ userId, orgId: org.id, firstOrg: created.firstOrg, granted: created.granted, decision: welcome });

  await prisma.user.update({
    where: { id: userId },
    data: { onboardingCompleted: true },
  });

  return org;
}
