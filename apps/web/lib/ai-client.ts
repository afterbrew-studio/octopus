import { prisma } from "@octopus/db";

export const HARDCODED_REVIEW_MODEL = "claude-sonnet-5";
export const HARDCODED_EMBED_MODEL = "text-embedding-3-large";

async function findPlatformDefault(category: "llm" | "embedding"): Promise<string | null> {
  const model = await prisma.availableModel.findFirst({
    where: { category, isPlatformDefault: true, isActive: true },
    select: { modelId: true },
  });
  return model?.modelId ?? null;
}

async function getPlatformDefault(category: "llm" | "embedding"): Promise<string | null> {
  try {
    return await findPlatformDefault(category);
  } catch (error) {
    console.error(`Failed to fetch platform default for ${category}:`, error);
    return null;
  }
}

export interface ResolvedReviewModel {
  model: string;
  /** Where the model came from; the platform default is not a pin. */
  source: "repo" | "org" | "platform";
  /** true when the model came from an explicit repo/org pin (not the platform default). */
  pinned: boolean;
}

function configuredUtilityModel(): string | null {
  return process.env.OCTOPUS_UTILITY_MODEL?.trim() || null;
}

/**
 * The model for callers with no organization. Without a platform default it is the
 * configured utility model, then the hardcoded default. A lookup error propagates.
 */
export async function getPlatformReviewModel(): Promise<string> {
  return (await findPlatformDefault("llm")) ?? configuredUtilityModel() ?? HARDCODED_REVIEW_MODEL;
}

/**
 * Resolve the review model AND report whether it was an explicit pin, in a
 * single pass of DB lookups. Single source of truth for the
 * repo-pin → org-pin → platform-default precedence; the router
 * (review-routing.ts) uses `pinned` to know when it may downshift.
 */
export async function resolveReviewModelPin(orgId: string, repoId?: string): Promise<ResolvedReviewModel> {
  if (repoId) {
    const repo = await prisma.repository.findUnique({
      where: { id: repoId },
      select: { reviewModelId: true },
    });
    if (repo?.reviewModelId) return { model: repo.reviewModelId, source: "repo", pinned: true };
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { defaultModelId: true },
  });
  if (org?.defaultModelId) return { model: org.defaultModelId, source: "org", pinned: true };

  return { model: (await getPlatformDefault("llm")) ?? HARDCODED_REVIEW_MODEL, source: "platform", pinned: false };
}

export async function getReviewModel(orgId: string, repoId?: string): Promise<string> {
  return (await resolveReviewModelPin(orgId, repoId)).model;
}

/**
 * The model for side tasks (titles, translation, the chat guard, reply
 * classification). `OCTOPUS_UTILITY_MODEL` pins a cheap model for all of them;
 * unset, they run on the review model.
 */
export async function getUtilityModel(orgId: string, repoId?: string): Promise<string> {
  return configuredUtilityModel() ?? getReviewModel(orgId, repoId);
}

export async function getEmbedModel(orgId: string, repoId?: string): Promise<string> {
  if (repoId) {
    const repo = await prisma.repository.findUnique({
      where: { id: repoId },
      select: { embedModelId: true },
    });
    if (repo?.embedModelId) return repo.embedModelId;
  }

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { defaultEmbedModelId: true },
  });
  if (org?.defaultEmbedModelId) return org.defaultEmbedModelId;

  return (await getPlatformDefault("embedding")) ?? HARDCODED_EMBED_MODEL;
}
