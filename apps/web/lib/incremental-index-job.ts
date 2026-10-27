import "server-only";
import { prisma } from "@octopus/db";
import { getInstallationToken } from "@/lib/github";
import { indexJobAbortMs } from "@/lib/index-liveness";

export interface IncrementalIndexJob {
  repositoryId: string;
  organizationId: string;
  prNumber: number;
  installationId: number;
}

/**
 * Re-indexes the files of one merged pull request. The queue allows one active job per repository
 * (singleton policy keyed by repository id), so updates of the same files never overlap, and content
 * is read from the default branch when the job runs, so the last job always ends on the newest content.
 * Any failure marks the index stale so the next review refreshes it.
 */
export async function processIncrementalIndex(
  job: IncrementalIndexJob,
  queue?: { signal?: AbortSignal; expireInSeconds?: number },
) {
  const repo = await prisma.repository.findFirst({
    where: { id: job.repositoryId, organizationId: job.organizationId, isActive: true },
    select: { id: true, fullName: true, defaultBranch: true, indexStatus: true, organizationId: true, activeIndexGeneration: true },
  });
  if (!repo) return;
  if (repo.indexStatus !== "indexed") {
    console.log(`[incremental-index] PR #${job.prNumber} merged, repo not indexed (${repo.indexStatus}), skipping`);
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException("Incremental indexing timed out", "TimeoutError")), indexJobAbortMs(queue?.expireInSeconds));
  const abortWithQueue = () => controller.abort(new DOMException("Incremental indexing job was aborted by the queue", "TimeoutError"));
  if (queue?.signal?.aborted) abortWithQueue();
  else queue?.signal?.addEventListener("abort", abortWithQueue, { once: true });
  const markStale = () => prisma.repository.updateMany({
    where: { id: repo.id, indexStatus: "indexed", activeIndexGeneration: repo.activeIndexGeneration },
    data: { indexStatus: "stale" },
  });
  try {
    const token = await getInstallationToken(job.installationId);
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
    let page = 1;
    const files: { filename: string; status: string }[] = [];
    while (true) {
      controller.signal.throwIfAborted();
      const res = await fetch(
        `https://api.github.com/repos/${repo.fullName}/pulls/${job.prNumber}/files?per_page=100&page=${page}`,
        { headers, signal: controller.signal },
      );
      if (!res.ok) throw new Error(`Could not list the files of PR #${job.prNumber}: HTTP ${res.status}`);
      const batch = await res.json() as { filename: string; status: string }[];
      if (batch.length === 0) break;
      files.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    if (files.length === 0) {
      await markStale();
      console.log(`[incremental-index] PR #${job.prNumber} merged, no changed files found via API, marked as stale`);
      return;
    }
    const { incrementalIndex } = await import("@/lib/indexer");
    const result = await incrementalIndex(
      { repoId: repo.id, activeIndexGeneration: repo.activeIndexGeneration, signal: controller.signal },
      repo.fullName,
      repo.defaultBranch,
      job.installationId,
      files,
      "github",
      repo.organizationId,
    );
    if (result.incompleteFiles.length > 0) {
      // The old chunks of these files were kept; the index is not current, so it is not stamped as fresh.
      await markStale();
      console.warn(`[incremental-index] PR #${job.prNumber} merged, ${result.incompleteFiles.length} file(s) could not be fetched, marked as stale`);
      return;
    }
    await prisma.repository.updateMany({
      where: { id: repo.id, indexStatus: "indexed", activeIndexGeneration: repo.activeIndexGeneration, indexedAt: { not: null } },
      data: { indexedAt: new Date() },
    });
    console.log(`[incremental-index] PR #${job.prNumber} merged: ${result.updatedFiles} updated, ${result.removedFiles} removed, ${result.newVectors} vectors`);
  } catch (err) {
    await markStale();
    console.warn(`[incremental-index] PR #${job.prNumber} incremental index failed, marked as stale:`, err);
  } finally {
    clearTimeout(timeout);
    queue?.signal?.removeEventListener("abort", abortWithQueue);
  }
}
