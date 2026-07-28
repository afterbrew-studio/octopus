"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@octopus/db";
import { getSuperAdmin } from "@/lib/superadmin";
import { asThinkingEffort } from "@/lib/providers/thinking";
import { writeAuditLog } from "@/lib/audit";

/**
 * Set the platform-default thinking-model reasoning effort
 * (SystemConfig.defaultReviewEffort). Super-admin only; an empty value clears
 * the override so the built-in code default (medium) applies. Orgs can still
 * override this per-org.
 */
export async function setPlatformReviewEffort(
  _prevState: { error?: string; success?: boolean },
  formData: FormData,
): Promise<{ error?: string; success?: boolean }> {
  const sa = await getSuperAdmin();
  if (!sa) return { error: "Not authorized." };

  const raw = (formData.get("defaultReviewEffort") as string)?.trim();
  const defaultReviewEffort = asThinkingEffort(raw) ?? null;

  await prisma.systemConfig.upsert({
    where: { id: "singleton" },
    update: { defaultReviewEffort },
    create: { id: "singleton", defaultReviewEffort },
  });

  await writeAuditLog({
    action: "platform.review_effort.update",
    category: "admin",
    actorId: sa.id,
    actorEmail: sa.email,
    targetType: "SystemConfig",
    targetId: "singleton",
    metadata: { defaultReviewEffort },
  });

  revalidatePath("/admin/settings");
  return { success: true };
}
