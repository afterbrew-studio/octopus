import "server-only";
import { prisma } from "@octopus/db";
import { asThinkingEffort, type ThinkingEffort } from "./providers/thinking";

/**
 * Resolve the thinking-model reasoning effort for an org:
 *   org override (Organization.reviewEffort)
 *   → platform default (SystemConfig.defaultReviewEffort)
 *   → undefined (provider falls back to env / built-in default).
 * Only matters for always-thinking models; other models ignore effort.
 */
export async function getReviewEffort(orgId: string): Promise<ThinkingEffort | undefined> {
  const [org, sysRow] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { reviewEffort: true },
    }),
    prisma.systemConfig.findUnique({
      where: { id: "singleton" },
      select: { defaultReviewEffort: true },
    }),
  ]);
  return asThinkingEffort(org?.reviewEffort) ?? asThinkingEffort(sysRow?.defaultReviewEffort);
}
