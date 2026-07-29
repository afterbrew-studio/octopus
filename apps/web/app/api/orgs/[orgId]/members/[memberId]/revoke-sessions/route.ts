import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { writeAuditLog } from "@/lib/audit";

// POST /api/orgs/:orgId/members/:memberId/revoke-sessions
// Sign a member out of Octopus by revoking all their sessions. Owner/admin only.
// NOTE: sessions are per-user, not per-org, so this signs the member out of
// EVERY organization and device they're using — not just this one.
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; memberId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, memberId } = await params;

  // Caller must be owner or admin of this org.
  const caller = await prisma.organizationMember.findFirst({
    where: {
      organizationId: orgId,
      userId: session.user.id,
      role: { in: ["owner", "admin"] },
      deletedAt: null,
    },
  });
  if (!caller) {
    return NextResponse.json({ error: "Forbidden: admin role required" }, { status: 403 });
  }

  // Target must be a current member of THIS org (prevents revoking arbitrary users).
  const target = await prisma.organizationMember.findFirst({
    where: { id: memberId, organizationId: orgId, deletedAt: null },
    select: { userId: true, role: true, user: { select: { email: true } } },
  });
  if (!target) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  // Use the self-service sign-out for your own sessions.
  if (target.userId === session.user.id) {
    return NextResponse.json(
      { error: "Cannot revoke your own sessions here. Use Settings → Sessions." },
      { status: 400 },
    );
  }

  // Protect the owner (mirrors remove/role-change guards).
  if (target.role === "owner") {
    return NextResponse.json({ error: "Cannot revoke the owner's sessions" }, { status: 400 });
  }

  const { count } = await prisma.session.deleteMany({ where: { userId: target.userId } });

  await writeAuditLog({
    action: "auth.member_sessions_revoked",
    category: "auth",
    actorId: session.user.id,
    actorEmail: session.user.email,
    organizationId: orgId,
    targetType: "user",
    targetId: target.userId,
    metadata: { memberId, email: target.user.email, count },
  });

  return NextResponse.json({ success: true, count });
}
