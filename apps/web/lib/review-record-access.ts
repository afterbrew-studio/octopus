import "server-only";
import type { Prisma } from "@octopus/db";

export function isReviewRecordId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function reviewRecordOrganization(userId: string): Prisma.OrganizationWhereInput {
  return { bannedAt: null, deletedAt: null, members: { some: { userId, deletedAt: null } } };
}

export function reviewRecordScope(id: string, organization: Prisma.OrganizationWhereInput): Prisma.ReviewAttemptWhereInput {
  return { id, pullRequest: { repository: { organization, isActive: true } } };
}

export const reviewRecordFields = {
  id: true, headSha: true, baseSha: true, coverage: true, reviewBody: true, createdAt: true,
} satisfies Prisma.ReviewAttemptSelect;
