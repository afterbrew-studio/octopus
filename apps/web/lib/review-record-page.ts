import "server-only";
import { prisma } from "@octopus/db";
import { auth } from "@/lib/auth";
import { isReviewRecordId, reviewRecordFields, reviewRecordOrganization, reviewRecordScope } from "./review-record-access";

export async function loadReviewRecordPage(id: string, requestHeaders: Headers) {
  if (!isReviewRecordId(id)) return { state: "not-found" } as const;
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) return { state: "signed-out" } as const;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id }, select: { bannedAt: true, mustChangePassword: true },
  });
  if (!user || user.bannedAt) return { state: "blocked" } as const;
  if (user.mustChangePassword) return { state: "password-change" } as const;
  const record = await prisma.reviewAttempt.findFirst({
    where: reviewRecordScope(id, reviewRecordOrganization(session.user.id)),
    select: {
      ...reviewRecordFields,
      coverage: false,
      pullRequest: {
        select: {
          number: true, repository: { select: { fullName: true } },
          reviewAttempts: {
            orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10,
            select: { id: true, headSha: true, createdAt: true },
          },
        },
      },
    },
  });
  return record ? { state: "found", record } as const : { state: "not-found" } as const;
}
