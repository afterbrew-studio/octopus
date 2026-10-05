import "server-only";
import { prisma, type Prisma } from "@octopus/db";

/**
 * A claim is a fencing token bound to the request it was taken for.
 *
 * The token alone is not enough: it outlives the request, and a worker holding a
 * stale one would write to whatever request the row has moved on to. So every
 * write a worker makes to the shared pull-request row is conditioned on the whole
 * identity (token, head SHA, request version) and on a status in which it may
 * still own the row. A write that matches nothing means the claim is gone, and
 * the worker stops.
 */
export type ClaimIdentity = {
  pullRequestId: string;
  claimToken: string;
  headSha: string | null;
  reviewRequestVersion: number;
};

/** Statuses in which the claiming worker owns the row. */
export const WHILE_REVIEWING = ["reviewing"] as const;
/** After the worker's own promotion to `completed`, which is still its to finish. */
export const WHILE_FINISHING = ["reviewing", "completed"] as const;

export class ClaimLostError extends Error {
  constructor() {
    super("The review claim is no longer held by this worker");
    this.name = "ClaimLostError";
  }
}

export function claimWhere(claim: ClaimIdentity, statuses: readonly string[] = WHILE_REVIEWING): Prisma.PullRequestWhereInput {
  return {
    id: claim.pullRequestId,
    claimToken: claim.claimToken,
    headSha: claim.headSha,
    reviewRequestVersion: claim.reviewRequestVersion,
    status: { in: [...statuses] },
  };
}

/** Applies `data` to the row only while the claim holds; false when it does not. */
export async function updateUnderClaim(
  claim: ClaimIdentity,
  data: Prisma.PullRequestUpdateManyMutationInput,
  statuses: readonly string[] = WHILE_REVIEWING,
  extraWhere: Prisma.PullRequestWhereInput = {},
): Promise<boolean> {
  const { count } = await prisma.pullRequest.updateMany({ where: { AND: [claimWhere(claim, statuses), extraWhere] }, data });
  return count === 1;
}

/** `updateUnderClaim`, where a miss means the claim was lost and the worker must stop. */
export async function writeUnderClaim(
  claim: ClaimIdentity,
  data: Prisma.PullRequestUpdateManyMutationInput,
  statuses: readonly string[] = WHILE_REVIEWING,
): Promise<void> {
  if (!(await updateUnderClaim(claim, data, statuses))) throw new ClaimLostError();
}

/**
 * The write that precedes a provider call. Landing proves the claim holds at that
 * instant, and refreshes `updatedAt`, which every reclaim path requires to be
 * stale. Each call after it is bounded well inside that window, so no renewal is
 * needed while the call runs.
 */
export async function reserveClaim(claim: ClaimIdentity): Promise<boolean> {
  return updateUnderClaim(claim, { updatedAt: new Date() });
}
