import "server-only";
import { prisma } from "@octopus/db";
import { enqueue } from "@/lib/queue";
import type { LogLevel } from "@/lib/indexer";
import { pubby } from "@/lib/pubby";
import { deleteSyncLogs, writeSyncLog } from "@/lib/elasticsearch";
import { createAbortController, clearAbortController } from "@/lib/indexing-abort";

export interface RepositoryIndexJob {
  repositoryId: string;
  organizationId: string;
}

// Revisit empty snapshots as well: a repository can be discovered before its
// first push. Failed enqueues remain eligible for the next discovery sweep.
const needsIndex = {
  OR: [
    { indexStatus: { in: ["pending", "failed"] } },
    { indexStatus: "indexed", totalFiles: 0 },
  ],
};

export async function enqueuePendingRepositoryIndexes(organizationId: string, repositoryId?: string, providers?: string[]) {
  const eligibleProviders = ["github", "forgejo"].filter(provider => !providers || providers.includes(provider));
  if (!eligibleProviders.length) return;
  const repos = await prisma.repository.findMany({
    where: {
      organizationId,
      ...(repositoryId ? { id: repositoryId } : {}),
      provider: { in: eligibleProviders },
      isActive: true,
      dismissedAt: null,
      organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true },
      ...needsIndex,
    },
    select: { id: true },
    orderBy: { indexedAt: { sort: "asc", nulls: "first" } },
    take: 200,
  });
  for (const repo of repos) {
    await enqueue("index-repository", { repositoryId: repo.id, organizationId }, {
      singletonKey: repo.id,
      singletonSeconds: 60,
    });
  }
}

export async function processRepositoryIndex(job: RepositoryIndexJob) {
  if (!job || typeof job.repositoryId !== "string" || !job.repositoryId ||
      typeof job.organizationId !== "string" || !job.organizationId) {
    throw new Error("Repository indexing requires repositoryId and organizationId");
  }
  // Recheck ownership and standing when the job runs: the installation may
  // have been disconnected, or the repository dismissed, while it was queued.
  const repo = await prisma.repository.findFirst({
    where: {
      id: job.repositoryId,
      organizationId: job.organizationId,
      provider: { in: ["github", "forgejo"] },
      isActive: true,
      dismissedAt: null,
      organization: { deletedAt: null, bannedAt: null, autoDiscoverRepos: true },
    },
    include: { organization: { select: { githubInstallationId: true } } },
  });
  const installationId = repo?.organization.githubInstallationId;
  if (!repo || (repo.provider === "github" && (!installationId || (repo.installationId && repo.installationId !== installationId)))) return;

  // Share the reviewer's claim so a first PR and discovery cannot both index.
  const claim = await prisma.repository.updateMany({
    where: { id: repo.id, organizationId: job.organizationId, ...needsIndex },
    data: { indexStatus: "indexing" },
  });
  if (!claim.count) return;

  const controller = createAbortController(repo.id);
  let timedOut = false;
  // Abort before pg-boss expires the attempt, so the catch can release its claim.
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 25 * 60_000);
  const channel = `presence-org-${job.organizationId}`;
  const notify = (status: string) => pubby.trigger(channel, "index-status", { repoId: repo.id, status })
    .catch((err: unknown) => console.warn("[repository-index] notification failed:", err));
  const log = (message: string, level: LogLevel = "info") => {
    writeSyncLog({ orgId: job.organizationId, repoId: repo.id, message, level, timestamp: Date.now() });
  };
  try {
    const { indexRepository } = await import("@/lib/indexer");
    await deleteSyncLogs(job.organizationId, repo.id);
    await notify("indexing");
    const stats = await indexRepository(
      repo.id, repo.fullName, repo.defaultBranch, installationId ?? 0, log,
      controller.signal, repo.provider, job.organizationId,
    );
    await prisma.repository.update({
      where: { id: repo.id },
      data: {
        indexStatus: "indexed",
        indexedAt: new Date(),
        totalFiles: stats.totalFiles,
        indexedFiles: stats.indexedFiles,
        totalChunks: stats.totalChunks,
        totalVectors: stats.totalVectors,
        contributorCount: stats.contributorCount,
        contributors: JSON.parse(JSON.stringify(stats.contributors)),
        indexDurationMs: stats.durationMs,
        ...(stats.resolvedDefaultBranch ? { defaultBranch: stats.resolvedDefaultBranch } : {}),
      },
    });
    log(`Indexing complete: ${stats.indexedFiles} files, ${stats.totalVectors} vectors`, "success");
    await notify("indexed");
  } catch (error) {
    const isCancelled = controller.signal.aborted && !timedOut;
    await prisma.repository.updateMany({
      where: { id: repo.id, organizationId: job.organizationId, indexStatus: "indexing" },
      data: { indexStatus: isCancelled ? "pending" : "failed" },
    });
    log(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    await notify(isCancelled ? "cancelled" : "failed");
    if (!isCancelled) throw error;
  } finally {
    clearTimeout(timeout);
    clearAbortController(repo.id);
  }
}
