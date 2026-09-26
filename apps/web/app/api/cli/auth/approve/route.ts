import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { generateApiToken, hashToken, getTokenPrefix } from "@/lib/api-auth";
import { generateCliUserToken } from "@/lib/cli-user-auth";
import { getAccountStanding, ACCOUNT_HOLD_MESSAGE } from "@/lib/account-standing";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(process.env.BETTER_AUTH_URL || request.url).origin) {
    return Response.json({ error: "Invalid request origin" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return Response.json({ error: "Not authenticated" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const deviceCode = typeof body?.deviceCode === "string" ? body.deviceCode.trim() : "";
  const organizationId = typeof body?.organizationId === "string" ? body.organizationId.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(deviceCode)) return Response.json({ error: "Invalid device code" }, { status: 400 });
  const authSession = await prisma.cliAuthSession.findUnique({ where: { deviceCode } });
  if (!authSession || authSession.status !== "pending") return Response.json({ error: "Invalid or already used device code" }, { status: 400 });
  if (authSession.expiresAt <= new Date()) return Response.json({ error: "Device code expired" }, { status: 410 });
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { bannedAt: true } });
  if (!user || user.bannedAt) return Response.json({ error: "Account is unavailable" }, { status: 403 });
  const userScope = authSession.scope === "user";
  const allowedKeys = userScope ? ["deviceCode"] : ["deviceCode", "organizationId"];
  if (Object.keys(body).some((key) => !allowedKeys.includes(key)) || (!userScope && !organizationId)) return Response.json({ error: "Invalid approval request" }, { status: 400 });

  let org: { id: string; name: string; slug: string } | null = null;
  if (!userScope) {
    const member = await prisma.organizationMember.findFirst({
      where: { userId: session.user.id, organizationId, deletedAt: null, organization: { deletedAt: null, bannedAt: null } },
      select: { organization: { select: { id: true, name: true, slug: true } } },
    });
    if (!member) return Response.json({ error: "Not a member of this organization" }, { status: 403 });
    if ((await getAccountStanding({ userId: session.user.id, orgId: organizationId })).held) return Response.json({ error: ACCOUNT_HOLD_MESSAGE }, { status: 403 });
    org = member.organization;
  }
  const rawToken = userScope ? generateCliUserToken() : generateApiToken();
  const approved = await prisma.$transaction(async (tx) => {
    // One claimant mints one token. Expiry and pending state are checked under
    // the same transaction as token creation; concurrent approvals cannot win.
    const claim = await tx.cliAuthSession.updateMany({
      where: { id: authSession.id, status: "pending", expiresAt: { gt: new Date() } },
      data: { status: "approved", token: rawToken, orgId: org?.id ?? null, orgSlug: org?.slug ?? null, orgName: org?.name ?? null, userName: session.user.name, userEmail: session.user.email },
    });
    if (!claim.count) return false;
    if (userScope) {
      await tx.cliUserToken.create({ data: { tokenHash: hashToken(rawToken), userId: session.user.id, expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    } else {
      await tx.orgApiToken.create({ data: { name: `CLI (${session.user.name ?? session.user.email})`, tokenHash: hashToken(rawToken), tokenPrefix: getTokenPrefix(rawToken), organizationId: org!.id, createdById: session.user.id } });
    }
    return true;
  });
  if (!approved) return Response.json({ error: "Device code expired or was already approved" }, { status: 409 });
  return Response.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
}
