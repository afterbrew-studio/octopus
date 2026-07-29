"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@octopus/db";
import { getSuperAdmin } from "@/lib/superadmin";
import { writeAuditLog } from "@/lib/audit";

/**
 * Revoke ALL sessions of a single user (by email) — forces them to re-login
 * everywhere. Super-admin only. Deleting the `sessions` rows invalidates every
 * session token immediately (better-auth validates tokens against the row).
 */
export async function revokeUserSessionsByEmail(
  _prev: { error?: string; success?: boolean; count?: number; email?: string },
  formData: FormData,
): Promise<{ error?: string; success?: boolean; count?: number; email?: string }> {
  const sa = await getSuperAdmin();
  if (!sa) return { error: "Not authorized." };

  const email = ((formData.get("email") as string) ?? "").trim().toLowerCase();
  if (!email) return { error: "Email is required." };

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true },
  });
  if (!user) return { error: `No user found for ${email}.` };

  const { count } = await prisma.session.deleteMany({ where: { userId: user.id } });

  await writeAuditLog({
    action: "admin.user_sessions_revoked",
    category: "admin",
    actorId: sa.id,
    actorEmail: sa.email,
    targetType: "user",
    targetId: user.id,
    metadata: { email: user.email, count },
  });

  revalidatePath("/admin/sessions");
  return { success: true, count, email: user.email };
}

/**
 * Nuclear option: revoke EVERY session platform-wide (incident response). This
 * signs out every user, including the acting super-admin. Requires a typed
 * confirmation server-side as well as in the UI.
 */
export async function revokeAllSessions(
  _prev: { error?: string; success?: boolean; count?: number },
  formData: FormData,
): Promise<{ error?: string; success?: boolean; count?: number }> {
  const sa = await getSuperAdmin();
  if (!sa) return { error: "Not authorized." };

  if (((formData.get("confirm") as string) ?? "").trim() !== "REVOKE ALL") {
    return { error: 'Type "REVOKE ALL" to confirm.' };
  }

  const { count } = await prisma.session.deleteMany({});

  await writeAuditLog({
    action: "admin.all_sessions_revoked",
    category: "admin",
    actorId: sa.id,
    actorEmail: sa.email,
    targetType: "platform",
    metadata: { count },
  });

  revalidatePath("/admin/sessions");
  return { success: true, count };
}
