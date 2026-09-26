import "server-only";
import { prisma } from "@octopus/db";
import { GithubRateLimitError } from "@/lib/github";
import { syncOrgRepos } from "@/lib/repo-sync";

/**
 * Hourly discovery sweep (scheduled in instrumentation.ts, worker in
 * queue-workers.ts): re-lists every connected provider for the least-recently
 * synced organizations so repositories created since the last sync appear
 * without anyone clicking Sync. GitHub also gets an instant path through the
 * `repository` webhook; this sweep is the safety net and the only path for
 * GitLab, Bitbucket and Forgejo.
 *
 * Fairness comes from the Organization.reposSyncedAt cursor: every org is
 * stamped after its attempt (success, failure, or rate limit) so a broken org
 * rotates to the back instead of pinning the sweep at position 0.
 */
// ponytail: fixed cap. Hourly x 200 = every org synced at least every ceil(N/200) h;
// tighten REPO_DISCOVERY_CRON before raising this when the fleet outgrows it.
export const DISCOVERY_BATCH_SIZE = 200;

export async function discoverRepositories(now: Date = new Date()): Promise<{
  orgs: number;
  created: number;
  removed: number;
  failed: number;
  rateLimited: boolean;
}> {
  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      bannedAt: null,
      autoDiscoverRepos: true,
      OR: [
        { githubInstallationId: { not: null } },
        { bitbucketIntegration: { isNot: null } },
        { gitlabIntegration: { isNot: null } },
        { forgejoIntegration: { isNot: null } },
      ],
    },
    orderBy: { reposSyncedAt: { sort: "asc", nulls: "first" } },
    take: DISCOVERY_BATCH_SIZE,
    select: { id: true },
  });

  let created = 0;
  let removed = 0;
  let failed = 0;
  let rateLimited = false;

  for (const org of orgs) {
    try {
      // Recover claims left by a crashed indexing worker. Do this BEFORE sync
      // upserts refresh updatedAt; 35 min exceeds the indexing queue's expiry.
      await prisma.repository.updateMany({
        where: {
          organizationId: org.id,
          provider: { in: ["github", "forgejo"] },
          isActive: true,
          dismissedAt: null,
          indexStatus: "indexing",
          updatedAt: { lt: new Date(now.getTime() - 35 * 60_000) },
        },
        data: { indexStatus: "failed" },
      });
      const r = await syncOrgRepos(org.id, { source: "scheduled" });
      created += r.created;
      removed += r.removed;
    } catch (err) {
      failed++;
      if (err instanceof GithubRateLimitError) rateLimited = true;
      console.error(`[discover-repositories] org ${org.id} failed:`, err);
    } finally {
      // updateMany: no throw if the row vanished mid-sweep, and a stamp failure
      // must never mask the sync error or abort the rest of the batch.
      await prisma.organization
        .updateMany({ where: { id: org.id }, data: { reposSyncedAt: now } })
        .catch((err) => console.error(`[discover-repositories] cursor stamp failed for org ${org.id}:`, err));
    }
    // A 429/403 from the installation-token mint is app-wide; one from a repo
    // listing is per-installation. We cannot cheaply tell them apart, so stop
    // the sweep either way: the cursor resumes the skipped orgs first next tick.
    if (rateLimited) break;
  }

  return { orgs: orgs.length, created, removed, failed, rateLimited };
}
