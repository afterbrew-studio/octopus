import "server-only";
import { prisma } from "@octopus/db";

/**
 * Renews this worker's claim on the row and reports whether it still holds it.
 *
 * A conditional write rather than a read. A read followed by a publication
 * leaves a window in which another worker can claim the row, and both then
 * publish. The write carries the claim token and the `reviewing` status, so it
 * only lands on a row this worker still owns and that nobody has reaped.
 * Landing also refreshes `updatedAt`, which every reclaim path (the claim query
 * and the reaper) requires to be older than the stale window, so the row cannot
 * be taken while the publication that follows is in flight.
 *
 * Idempotent: repeating it only moves `updatedAt` forward.
 */
export async function reserveClaim(pullRequestId: string, claimToken: string): Promise<boolean> {
  const { count } = await prisma.pullRequest.updateMany({
    where: { id: pullRequestId, claimToken, status: "reviewing" },
    data: { updatedAt: new Date() },
  });
  return count === 1;
}
