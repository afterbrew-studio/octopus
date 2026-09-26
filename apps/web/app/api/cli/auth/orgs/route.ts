import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { createOrgForUser } from "@/lib/org-create";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Not authenticated" }, { status: 401 });
  }

  const deviceCode = new URL(request.url).searchParams.get("device_code");
  if (deviceCode !== null) {
    if (!/^[0-9a-f]{40}$/.test(deviceCode)) return Response.json({ error: "Invalid device code" }, { status: 400 });
    const device = await prisma.cliAuthSession.findUnique({ where: { deviceCode } });
    if (!device || device.expiresAt <= new Date() || device.status !== "pending") return Response.json({ error: "Device code expired or already used. Run octp login again." }, { status: 410 });
    if (device.scope === "user") return Response.json({ scope: "user", organizations: [], user: { name: session.user.name, email: session.user.email } }, { headers: { "Cache-Control": "no-store" } });
  }

  let memberships = await prisma.organizationMember.findMany({
    where: {
      userId: session.user.id,
      deletedAt: null,
      organization: { deletedAt: null, bannedAt: null },
    },
    select: {
      organization: {
        select: { id: true, name: true, slug: true },
      },
    },
  });

  // If user has no organization, create one automatically
  if (memberships.length === 0) {
    try {
      const userName = session.user.name || session.user.email?.split("@")[0] || "User";
      await createOrgForUser(session.user.id, userName);
    } catch (err) {
      // Likely a concurrent request already created the org, or org limit reached
      console.warn("[cli/orgs] Auto-create org failed:", err instanceof Error ? err.message : err);
    }

    memberships = await prisma.organizationMember.findMany({
      where: {
        userId: session.user.id,
        deletedAt: null,
        organization: { deletedAt: null, bannedAt: null },
      },
      select: {
        organization: {
          select: { id: true, name: true, slug: true },
        },
      },
    });
  }

  const organizations = memberships.map((m) => m.organization);

  return Response.json({ organizations });
}
