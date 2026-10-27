import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@octopus/db";
import { runRepositoryIndex, SupersededIndexError } from "@/lib/repository-index-completion";
import { canIndexInBackground, enqueueRepositoryIndexRefresh } from "@/lib/repository-index-job";

type RefreshTarget = { id: string; fullName: string; defaultBranch: string; installationId: number | null };

/**
 * Queues the background refresh of a stale GitHub index when the job can index the repository
 * (an installation bound to its organization). Returns false when it cannot, so the caller
 * can decide what else to do; a failed enqueue still counts as queued, since the next review asks again.
 */
export async function queueIndexRefresh(repo: RefreshTarget, organizationId: string): Promise<boolean> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { githubInstallationId: true } });
  if (!canIndexInBackground({ provider: "github", installationId: repo.installationId }, org?.githubInstallationId)) return false;
  await enqueueRepositoryIndexRefresh(repo.id, organizationId)
    .catch((err) => console.error("[index-refresh] Failed to enqueue index refresh:", err));
  return true;
}

/** Refreshes with a request token, for a repository the job cannot index. Stops at `budgetMs`; a failure leaves the index stale. */
export async function refreshIndexWithToken(repo: RefreshTarget, organizationId: string, githubToken: string, budgetMs: number) {
  const indexAttemptId = randomUUID();
  const claim = await prisma.repository.updateMany({
    where: { id: repo.id, indexStatus: { notIn: ["indexed", "indexing"] } },
    data: { indexStatus: "indexing", indexAttemptId },
  });
  if (!claim.count) return;
  const signal = AbortSignal.timeout(budgetMs);
  const { indexRepository } = await import("@/lib/indexer");
  await runRepositoryIndex(repo.id, indexAttemptId, () => indexRepository(
    { repoId: repo.id, indexAttemptId }, repo.fullName, repo.defaultBranch, 0, () => {},
    signal, "github", organizationId, githubToken,
  ), signal).catch((err) => {
    if (!(err instanceof SupersededIndexError)) console.error("[index-refresh] Token-backed refresh failed:", err);
  });
}
