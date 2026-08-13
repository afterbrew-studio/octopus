import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";
import { createCheckoutSession } from "@/lib/stripe";

export async function POST(req: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { orgId, amount } = body as { orgId: string; amount: number };

  if (!orgId || typeof amount !== "number" || amount < 5 || amount > 1000) {
    return NextResponse.json(
      { error: "Amount must be between $5 and $1,000" },
      { status: 400 },
    );
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
    return NextResponse.json({ error: "Only owners can purchase credits" }, { status: 403 });
  }

  const returnUrl = `${process.env.BETTER_AUTH_URL || req.nextUrl.origin}/settings/billing`;
  const url = await createCheckoutSession(orgId, amount, returnUrl);

  return NextResponse.json({ url });
}
