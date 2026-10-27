import "server-only";
import { randomUUID } from "node:crypto";
import { runRepositoryIndex, SupersededIndexError, isIndexingCancelled } from "@/lib/repository-index-completion";
import { prisma } from "@octopus/db";
import { enqueue } from "@/lib/queue";
import type { LogLevel } from "@/lib/indexer";
import { notifyRepositoryIndex } from "@/lib/repository-index-notifications";
import { deleteSyncLogs, writeSyncLog } from "@/lib/elasticsearch";
import { createAbortController, clearAbortController } from "@/lib/indexing-abort";
import { indexJobAbortMs } from "@/lib/index-liveness";
import { USABLE_INDEX_WHERE } from "@/lib/usable-index";

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
// Discovery leaves a stale index to the review that finds it; the refresh job it queues may claim it.
const claimable = { OR: [...needsIndex.OR, { indexStatus: "stale" }] };

// Narrower than the job's own providers: discovery only auto-indexes these.
const DISCOVERY_PROVIDERS = ["github", "forgejo"];
const JOB_PROVIDERS = [...DISCOVERY_PROVIDERS, "gitlab", "bitbucket"];

/** The job indexes a GitHub repository only through the installation bound to its own organization. */
export function canIndexInBackground(
  repo: { provider: string; installationId: number | null },
  organizationInstallationId: number | null | undefined,
): boolean {
  if (repo.provider !== "github") return true;
  return !!organizationInstallationId && (!repo.installationId || repo.installationId === organizationInstallationId);
}

export function enqueueRepositoryIndexRefresh(repositoryId: string, organizationId: string) {
  return enqueue("index-repository", { repositoryId, organizationId }, {
    singletonKey: repositoryId,
    singletonSeconds: 60,
  });
}

export async function enqueuePendingRepositoryIndexes(organizationId: string, repositoryId?: string, providers?: string[]) {
  const eligibleProviders = DISCOVERY_PROVIDERS.filter(provider => !providers || providers.includes(provider));
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
  for (const repo of repos) await enqueueRepositoryIndexRefresh(repo.id, organizationId);
}

export async function processRepositoryIndex(
  job: RepositoryIndexJob,
  queue?: { signal?: AbortSignal; expireInSeconds?: number },
) {
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
      provider: { in: JOB_PROVIDERS },
      isActive: true,
      dismissedAt: null,
      organization: { deletedAt: null, bannedAt: null },
      // A repository that already has an index was opted in by use; only first-time indexing needs auto-discovery.
      OR: [{ organization: { autoDiscoverRepos: true } }, USABLE_INDEX_WHERE],
    },
    include: { organization: { select: { githubInstallationId: true } } },
  });
  const installationId = repo?.organization.githubInstallationId;
  if (!repo || !canIndexInBackground(repo, installationId)) return;

  // Share the reviewer's claim so a first PR and discovery cannot both index.
  const indexAttemptId = randomUUID();
  const claim = await prisma.repository.updateMany({
    where: { id: repo.id, organizationId: job.organizationId, ...claimable },
    data: { indexStatus: "indexing", indexAttemptId },
  });
  if (!claim.count) return;

  const controller = createAbortController(indexAttemptId);
  // Abort before pg-boss expires the attempt, so the catch can release its claim.
  const timeout = setTimeout(() => controller.abort(new DOMException("Repository indexing timed out", "TimeoutError")), indexJobAbortMs(queue?.expireInSeconds));
  // pg-boss aborts the signal when it gives up on the job (expiry, shutdown); the run must stop with it.
  const abortWithQueue = () => controller.abort(new DOMException("Repository indexing job was aborted by the queue", "TimeoutError"));
  if (queue?.signal?.aborted) abortWithQueue();
  else queue?.signal?.addEventListener("abort", abortWithQueue, { once: true });
  const channel = `presence-org-${job.organizationId}`;
  const log = (message: string, level: LogLevel = "info") => {
    writeSyncLog({ orgId: job.organizationId, repoId: repo.id, message, level, timestamp: Date.now() });
  };
  try {
    const stats = await runRepositoryIndex(repo.id, indexAttemptId, async () => {
      const { indexRepository } = await import("@/lib/indexer");
      await deleteSyncLogs(job.organizationId, repo.id);
      void notifyRepositoryIndex(channel, repo.id);
      return indexRepository(
        { repoId: repo.id, indexAttemptId }, repo.fullName, repo.defaultBranch, installationId ?? 0, log,
        controller.signal, repo.provider, job.organizationId,
      );
    }, controller.signal);
    log(`Indexing complete: ${stats.indexedFiles} files, ${stats.totalVectors} vectors`, "success");
    void notifyRepositoryIndex(channel, repo.id);
  } catch (error) {
    if (error instanceof SupersededIndexError) return;
    const isCancelled = isIndexingCancelled(controller.signal);
    log(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    void notifyRepositoryIndex(channel, repo.id);
    if (!isCancelled) throw error;
  } finally {
    clearTimeout(timeout);
    queue?.signal?.removeEventListener("abort", abortWithQueue);
    clearAbortController(indexAttemptId);
  }
}
