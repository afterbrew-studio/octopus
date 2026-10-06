import "server-only";
import { readBoundedJson } from "@/lib/bounded-json";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { pubby } from "@/lib/pubby";

async function getSessionAndConversation(request: Request, id: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const parsed = await readBoundedJson(request, 1024 * 1024);
  if (!parsed.ok) {
    return { error: Response.json({ error: parsed.reason === "too_large" ? "Request too large" : "Invalid JSON body" }, { status: parsed.reason === "too_large" ? 413 : 400 }) };
  }
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { error: Response.json({ error: "Expected a JSON object" }, { status: 400 }) };
  }
  const body = parsed.value as Record<string, unknown>;
  const { orgId } = body;
  if (typeof orgId !== "string" || !orgId.trim()) {
    return { error: Response.json({ error: "Missing orgId" }, { status: 400 }) };
  }

  // Verify org membership
  const membership = await prisma.organizationMember.findFirst({
    where: { organizationId: orgId, userId: session.user.id, deletedAt: null },
  });
  if (!membership) {
    return { error: Response.json({ error: "Not a member" }, { status: 403 }) };
  }

  // Only owner can share/unshare
  const conversation = await prisma.chatConversation.findFirst({
    where: { id, userId: session.user.id, organizationId: orgId, deletedAt: null },
  });
  if (!conversation) {
    return { error: Response.json({ error: "Conversation not found or not owned by you" }, { status: 404 }) };
  }

  return { session, orgId, conversation };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getSessionAndConversation(request, id);
  if ("error" in result) return result.error;
  const { session, orgId, conversation } = result;

  if (conversation.isShared) {
    return Response.json({ error: "Already shared" }, { status: 400 });
  }

  const updated = await prisma.chatConversation.update({
    where: { id },
    data: {
      isShared: true,
      sharedAt: new Date(),
      sharedById: session.user.id,
    },
    select: { id: true, title: true, isShared: true },
  });

  // Notify org members via pubby
  try {
    await pubby.trigger(`presence-org-${orgId}`, "chat-shared", {
      conversationId: id,
      title: updated.title,
      sharedBy: session.user.name,
    });
  } catch {}

  return Response.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getSessionAndConversation(request, id);
  if ("error" in result) return result.error;
  const { orgId, conversation } = result;

  if (!conversation.isShared) {
    return Response.json({ error: "Not shared" }, { status: 400 });
  }

  const updated = await prisma.chatConversation.update({
    where: { id },
    data: {
      isShared: false,
      sharedAt: null,
      sharedById: null,
    },
    select: { id: true, title: true, isShared: true },
  });

  // Notify org members so they refresh their lists
  try {
    await pubby.trigger(`presence-org-${orgId}`, "chat-shared", {
      conversationId: id,
      title: updated.title,
      unshared: true,
    });
  } catch {}

  return Response.json(updated);
}
