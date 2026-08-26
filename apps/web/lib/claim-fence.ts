import "server-only";
import { prisma } from "@octopus/db";

/**
 * Whether this worker still owns the row.
 *
 * Read rather than written, so it is cheap enough to sit in front of an external
 * publication. It is advisory by nature -- the row can be taken between this
 * check and the next line -- which is why the terminal write is fenced as well,
 * by a conditional update that cannot be raced.
 */
export async function stillOurs(pullRequestId: string, claimToken: string): Promise<boolean> {
  const row = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
    select: { claimToken: true },
  });
  return row?.claimToken === claimToken;
}
