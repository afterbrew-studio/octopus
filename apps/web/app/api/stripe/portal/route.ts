import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";
import { createPortalSession } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { orgId } = body as { orgId: string };

  if (!orgId) {
    return NextResponse.json({ error: "Missing orgId" }, { status: 400 });
  }

  const member = await prisma.organizationMember.findFirst({
    where: {
      organizationId: orgId,
      userId: session.user.id,
      deletedAt: null,
    },
  });

  // Aligned with the billing server actions: billing:manage (admin+owner
  // baseline) rather than the previous owner-only rule.
  if (!member || !hasOrgPermission(member, "billing:manage")) {
    return NextResponse.json({ error: "Only owners can manage billing" }, { status: 403 });
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { stripeCustomerId: true },
  });

  if (!org?.stripeCustomerId) {
    return NextResponse.json(
      { error: "No billing account. Purchase credits first." },
      { status: 400 },
    );
  }

  const returnUrl = `${process.env.BETTER_AUTH_URL || req.nextUrl.origin}/settings/billing`;
  const url = await createPortalSession(orgId, returnUrl);

  return NextResponse.json({ url });
}
