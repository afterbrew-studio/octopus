import "server-only";
import { prisma } from "@octopus/db";
import { summarizeRepository } from "@/lib/summarizer";
import { analyzeRepository } from "@/lib/analyzer";
import { enqueueAfter } from "@/lib/queue";
import { pubby } from "@/lib/pubby";
import { eventBus } from "@/lib/events";

// Allow both AI calls to finish before recovering an abandoned analysis claim.
const STALE_ANALYSIS_MS = 35 * 60_000;

export async function ensureRepositoryAnalysis(
  repositoryId: string,
  organizationId: string,
  onStart?: () => Promise<void>,
): Promise<"ready" | "empty" | "waiting"> {
  // Read fresh state: discovery or a different PR may have finished indexing.
  const repo = await prisma.repository.findFirst({
    where: { id: repositoryId, organizationId },
    select: { fullName: true, indexStatus: true, totalChunks: true, analysisStatus: true },
  });
  if (!repo) throw new Error("Repository not found for analysis");
  if (repo.indexStatus !== "indexed") return "waiting";
  if (repo.totalChunks === 0) return "empty";
  if (repo.analysisStatus === "analyzed") return "ready";

  const claim = await prisma.repository.updateMany({
    where: {
      id: repositoryId,
      organizationId,
      indexStatus: "indexed",
      totalChunks: { gt: 0 },
      OR: [
        { analysisStatus: { notIn: ["analyzing", "analyzed"] } },
        { analysisStatus: "analyzing", updatedAt: { lt: new Date(Date.now() - STALE_ANALYSIS_MS) } },
      ],
    },
    data: { analysisStatus: "analyzing" },
  });
  if (!claim.count) return "waiting";

  const channel = `presence-org-${organizationId}`;
  const notify = (status: string) => pubby.trigger(channel, "analysis-status", { repoId: repositoryId, status })
    .catch((err: unknown) => console.error("[reviewer] Analysis notification failed:", err));
  try {
    await notify("analyzing");
    await onStart?.();
    const { summary, purpose } = await summarizeRepository(repositoryId, repo.fullName, organizationId);
    const analysis = await analyzeRepository(repositoryId, repo.fullName, organizationId);
    await prisma.repository.update({
      where: { id: repositoryId, organizationId },
      data: { summary, purpose, analysis, analysisStatus: "analyzed", analyzedAt: new Date() },
    });
    await notify("analyzed");
    await pubby.trigger(channel, "repo-analyzed", { repoId: repositoryId, fullName: repo.fullName })
      .catch((err: unknown) => console.error("[reviewer] Repository analysis notification failed:", err));
    eventBus.emit({ type: "repo-analyzed", orgId: organizationId, repoFullName: repo.fullName });
    return "ready";
  } catch (error) {
    await prisma.repository.updateMany({
      where: { id: repositoryId, organizationId, analysisStatus: "analyzing" },
      data: { analysisStatus: "failed" },
    });
    await notify("failed");
    throw error;
  }
}

export async function deferReviewForRepository(pullRequestId: string, headSha?: string | null, reviewRequestVersion?: number, reviewRunId?: string): Promise<void> {
  // Must be "queued", not "pending": `attemptOutcomeForStatus` treats "pending"
  // as an early exit and finalizes the frozen run as cancelled the moment this
  // function returns, so a later success could never overwrite that terminal
  // state. "queued" is its non-terminal case, matching the low-balance
  // deferral in `reviewer.ts`, which re-enqueues the same run the same way.
  //
  // This does not reuse the large-review "queued" claim window: that window is
  // keyed off the run's own `state` (set to "queued" only at the large-review
  // handoff), not off the pull request's `status`, so a prerequisite retry
  // stays claimable on the short window.
  const changed = await prisma.pullRequest.updateMany({ where: { id: pullRequestId, ...(headSha !== undefined ? { headSha } : {}), ...(reviewRequestVersion !== undefined ? { reviewRequestVersion } : {}) }, data: { status: "queued" } });
  if (!changed.count) return;
  // The retry re-executes under the SAME frozen run, not live configuration --
  // dropping this here would let a label-selected model silently change on
  // the retry. rayf P-0007 C3.
  const jobId = await enqueueAfter("process-review", reviewRunId ? { pullRequestId, reviewRunId } : { pullRequestId }, 30);
  if (!jobId) throw new Error("Could not enqueue review after repository preparation");
}
