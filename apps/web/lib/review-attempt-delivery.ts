import "server-only";
import { randomUUID } from "node:crypto";
import { prisma, type Prisma, type ReviewAttemptDelivery } from "@octopus/db";

const LEASE_MS = 5 * 60 * 1000;

/** Resume delivery without changing the immutable body or assessment evidence. */
export async function deliverReviewAttempt(
  attemptId: string,
  deliver: (progress: ReviewAttemptDelivery, checkpoint: (data: Prisma.ReviewAttemptDeliveryUpdateManyMutationInput) => Promise<void>) => Promise<void>,
): Promise<void> {
  await prisma.reviewAttemptDelivery.createMany({ skipDuplicates: true, data: [{ attemptId }] });
  const leaseToken = randomUUID();
  const claimed = await prisma.reviewAttemptDelivery.updateMany({
    where: { attemptId, completedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
    data: { leaseToken, leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  if (!claimed.count) {
    const progress = await prisma.reviewAttemptDelivery.findUniqueOrThrow({ where: { attemptId } });
    if (progress.completedAt) return;
    throw new Error("Review attempt delivery is already in progress; retry later");
  }
  const checkpoint = async (data: Prisma.ReviewAttemptDeliveryUpdateManyMutationInput) => {
    const updated = await prisma.reviewAttemptDelivery.updateMany({
      where: { attemptId, leaseToken, leaseUntil: { gt: new Date() } },
      data: { ...data, leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (!updated.count) throw new Error("Review attempt delivery lease expired; retry later");
  };
  try {
    const progress = await prisma.reviewAttemptDelivery.findUniqueOrThrow({ where: { attemptId } });
    await deliver(progress, checkpoint);
    await checkpoint({ completedAt: new Date() });
  } finally {
    await prisma.reviewAttemptDelivery.updateMany({ where: { attemptId, leaseToken }, data: { leaseToken: null, leaseUntil: null } });
  }
}
