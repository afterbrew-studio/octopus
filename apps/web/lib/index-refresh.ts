import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@octopus/db";
import { runRepositoryIndex, SupersededIndexError } from "@/lib/repository-index-completion";
import { canIndexInBackground, enqueueRepositoryIndexRefresh } from "@/lib/repository-index-job";

// A token-backed refresh must finish while the caller's short-lived token is valid.
const TOKEN_REFRESH_BUDGET_MS = 10 * 60_000;

type RefreshTarget = { id: string; fullName: string; defaultBranch: string; installationId: number | null };

/**
 * Starts the refresh of a stale GitHub index without holding up the review. A repository the
 * background job can index is queued. One reachable only through a request token is refreshed
 * by the returned function, which the caller runs once its review exists and the token is
 * still valid. A failure leaves the index stale, so the next review asks again.
 */
export async function requestIndexRefresh(
  repo: RefreshTarget,
  organizationId: string,
  githubToken: string,
): Promise<(() => Promise<void>) | null> {
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { githubInstallationId: true } });
  if (canIndexInBackground({ provider: "github", installationId: repo.installationId }, org?.githubInstallationId)) {
    await enqueueRepositoryIndexRefresh(repo.id, organizationId)
      .catch((err) => console.error("[index-refresh] Failed to enqueue index refresh:", err));
    return null;
  }
  return () => refreshWithToken(repo, organizationId, githubToken);
}

async function refreshWithToken(repo: RefreshTarget, organizationId: string, githubToken: string) {
  const indexAttemptId = randomUUID();
  const claim = await prisma.repository.updateMany({
    where: { id: repo.id, indexStatus: { notIn: ["indexed", "indexing"] } },
    data: { indexStatus: "indexing", indexAttemptId },
  });
  if (!claim.count) return;
  const signal = AbortSignal.timeout(TOKEN_REFRESH_BUDGET_MS);
  const { indexRepository } = await import("@/lib/indexer");
  await runRepositoryIndex(repo.id, indexAttemptId, () => indexRepository(
    { repoId: repo.id, indexAttemptId }, repo.fullName, repo.defaultBranch, 0, () => {},
    signal, "github", organizationId, githubToken,
  ), signal).catch((err) => {
    if (!(err instanceof SupersededIndexError)) console.error("[index-refresh] Token-backed refresh failed:", err);
  });
}
