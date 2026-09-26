import "server-only";
import { prisma } from "@octopus/db";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const deviceCode = request.nextUrl.searchParams.get("device_code");
  if (!deviceCode) {
    return Response.json({ error: "Missing device_code" }, { status: 400 });
  }

  const session = await prisma.cliAuthSession.findUnique({
    where: { deviceCode },
  });

  if (!session) {
    return Response.json({ error: "Invalid device code" }, { status: 404 });
  }

  if (session.expiresAt < new Date()) {
    return Response.json({ error: "Device code expired" }, { status: 410 });
  }

  if (session.status === "pending") {
    return Response.json({ status: "pending" });
  }

  if (session.status === "approved" && session.token) {
    const token = session.token;

    // Atomic clear — only succeed if token still exists (prevents double-read race)
    const updated = await prisma.cliAuthSession.updateMany({
      where: { id: session.id, status: "approved", expiresAt: { gt: new Date() }, token: { not: null } },
      data: { token: null },
    });

    if (updated.count === 0) {
      return Response.json({ error: "Token already consumed" }, { status: 410 });
    }

    return Response.json({
      status: "approved",
      token,
      scope: session.scope,
      organization: session.scope === "user" ? null : {
        id: session.orgId,
        slug: session.orgSlug,
        name: session.orgName,
      },
      user: {
        name: session.userName,
        email: session.userEmail,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  }

  return Response.json({ status: "pending" });
}
