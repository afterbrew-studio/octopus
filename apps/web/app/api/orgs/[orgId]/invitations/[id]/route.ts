import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";

// DELETE /api/orgs/:orgId/invitations/:id — Revoke invitation
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ orgId: string; id: string }> }
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId, id } = await params;

  const member = await prisma.organizationMember.findFirst({
    where: {
      organizationId: orgId,
      userId: session.user.id,
      deletedAt: null,
    },
  });
  if (!member || !hasOrgPermission(member, "members:manage")) {
    return NextResponse.json({ error: "Forbidden: admin role required" }, { status: 403 });
  }

  const invitation = await prisma.organizationInvitation.findFirst({
    where: { id, organizationId: orgId },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  if (invitation.status === "accepted") {
    // Soft-delete the org member associated with this invitation
    const user = await prisma.user.findFirst({
      where: { email: invitation.email },
      select: { id: true },
    });
    if (user) {
      await prisma.organizationMember.updateMany({
        where: { organizationId: orgId, userId: user.id, deletedAt: null },
        data: { deletedAt: new Date(), removedById: session.user.id },
      });
    }
  }

  await prisma.organizationInvitation.update({
    where: { id },
    data: { status: "revoked" },
  });

  return NextResponse.json({ success: true });
}
