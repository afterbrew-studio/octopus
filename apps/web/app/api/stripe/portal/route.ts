import "server-only";
import { isPostgresSafeJson, readBoundedJson } from "@/lib/bounded-json";
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

  const parsed = await readBoundedJson(req, 1024 * 1024);
  if (!parsed.ok) {
    return Response.json({ error: parsed.reason === "too_large" ? "Request too large" : "Invalid JSON body" }, { status: parsed.reason === "too_large" ? 413 : 400 });
  }
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return Response.json({ error: "Expected a JSON object" }, { status: 400 });
  }
  if (!isPostgresSafeJson(parsed.value)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const body = parsed.value as Record<string, unknown>;
  const { orgId } = body;

  if (typeof orgId !== "string" || !orgId.trim()) {
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
