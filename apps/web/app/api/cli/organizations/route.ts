import "server-only";
import { prisma } from "@octopus/db";
import { authenticateCliUser, deriveCliOrgToken, hashCliToken } from "@/lib/cli-user-auth";
import { getAccountStanding, ACCOUNT_HOLD_MESSAGE } from "@/lib/account-standing";
import { parseConnectRepository } from "@/lib/cli-repo-connect";

const noStore = { headers: { "Cache-Control": "no-store" } };

export async function GET(request: Request) {
  const identity = await authenticateCliUser(request);
  if (!identity) return Response.json({ error: "Sign in again with octp login." }, { status: 401, ...noStore });
  const repo = new URL(request.url).searchParams.get("repo");
  if (repo !== null && !parseConnectRepository({ fullName: repo })) return Response.json({ error: "Invalid repository." }, { status: 400, ...noStore });
  const memberships = await prisma.organizationMember.findMany({
    where: { userId: identity.user.id, deletedAt: null, organization: { deletedAt: null, bannedAt: null } },
    select: { organization: { select: { id: true, slug: true, name: true, githubInstallationId: true } } },
    orderBy: { organization: { slug: "asc" } },
  });
  const orgIds = memberships.map((m) => m.organization.id);
  const repositories = repo && orgIds.length ? await prisma.repository.findMany({
    where: { organizationId: { in: orgIds }, provider: "github", isActive: true, dismissedAt: null, fullName: { startsWith: `${repo.split("/")[0]}/`, mode: "insensitive" } },
    select: { organizationId: true, fullName: true },
  }) : [];
  return Response.json({
    user: { name: identity.user.name, email: identity.user.email },
    organizations: memberships.map(({ organization: org }) => ({
      id: org.id, slug: org.slug, name: org.name, hasInstallation: org.githubInstallationId !== null,
      matchesRepository: repositories.some((r) => r.organizationId === org.id && r.fullName.toLowerCase() === repo?.toLowerCase()),
      matchesOwner: repositories.some((r) => r.organizationId === org.id),
    })),
  }, noStore);
}

export async function POST(request: Request) {
  const identity = await authenticateCliUser(request);
  if (!identity) return Response.json({ error: "Sign in again with octp login." }, { status: 401, ...noStore });
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !("organization" in body) || typeof body.organization !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.organization)) {
    return Response.json({ error: "Supply an organization ID or slug." }, { status: 400, ...noStore });
  }
  const member = await prisma.organizationMember.findFirst({
    where: { userId: identity.user.id, deletedAt: null, organization: { deletedAt: null, bannedAt: null, OR: [{ id: body.organization }, { slug: body.organization }] } },
    include: { organization: true },
  });
  if (!member) return Response.json({ error: "Organization is not available to this user." }, { status: 403, ...noStore });
  const org = member.organization;
  const standing = await getAccountStanding({ userId: identity.user.id, orgId: org.id });
  if (standing.held) return Response.json({ error: ACCOUNT_HOLD_MESSAGE }, { status: 403, ...noStore });
  const rawToken = deriveCliOrgToken(identity.raw, org.id);
  // A revoked child stays revoked; choosing an org must never undo revocation.
  const token = await prisma.orgApiToken.upsert({
    where: { cliUserTokenId_organizationId: { cliUserTokenId: identity.token.id, organizationId: org.id } },
    create: { name: "CLI user session", tokenHash: hashCliToken(rawToken), tokenPrefix: `${rawToken.slice(0, 8)}...`, createdById: identity.user.id, organizationId: org.id, cliUserTokenId: identity.token.id, expiresAt: identity.token.expiresAt },
    update: {},
  });
  if (token.deletedAt) return Response.json({ error: "CLI access to this organization was revoked. Sign in again." }, { status: 403, ...noStore });
  return Response.json({ token: rawToken, organization: { id: org.id, slug: org.slug, name: org.name } }, noStore);
}
