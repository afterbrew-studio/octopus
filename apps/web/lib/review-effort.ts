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
  // Effort is a non-critical enhancement: on any DB error, fall through to
  // undefined so the provider uses the env/built-in default rather than failing
  // the whole AI call. Mirrors the defensive systemConfig reads in review-core.
  try {
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
  } catch (err) {
    console.error("[review-effort] failed to resolve effort, using provider default:", err);
    return undefined;
  }
}
