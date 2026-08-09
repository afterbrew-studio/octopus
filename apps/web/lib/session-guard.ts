import "server-only";
import { APIError } from "better-auth/api";
import { prisma } from "@octopus/db";
import { writeAuditLog } from "./audit";

/**
 * Session-creation gate: a banned user must not be able to mint a new session.
 *
 * The admin ban deletes all existing sessions, but without this hook the user
 * could simply sign back in — pages are guarded by the (app) layout redirect,
 * while API routes (e.g. /api/chat) only require a valid session, so a fresh
 * login would let a banned user keep consuming the API. Blocking at session
 * creation covers every current and future route in one place.
 */
export async function assertUserNotBanned(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, bannedAt: true },
  });

  if (!user?.bannedAt) return;

  await writeAuditLog({
    action: "auth.login_blocked",
    category: "auth",
    actorId: userId,
    actorEmail: user.email,
    targetType: "user",
    targetId: userId,
    metadata: { reason: "banned" },
  });
  throw new APIError("FORBIDDEN", {
    message: "This account has been suspended.",
  });
}
