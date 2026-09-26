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
  // Must be "pending", not "queued": `processReviewInternal`'s own claim query
  // only takes a "queued" row once it is older than the large-review stale
  // window (~35 minutes), so a "queued" retry scheduled 30 seconds out would
  // never be claimable when it actually runs -- it would silently no-op every
  // time until the stuck-review reaper eventually swept it. "pending" is the
  // fresh-claim branch that query accepts unconditionally, which is what the
  // pre-merge flow relied on.
  //
  // A frozen run is kept non-terminal across this NOT by the pull request's
  // status (which `attemptOutcomeForStatus` would otherwise read as a
  // finished-without-running exit and finalize as cancelled), but by
  // `processReviewInternal` reporting "deferred" back to `processReview`,
  // which skips finalization on that signal instead of inferring it from
  // status. See the "deferred" return in reviewer.ts.
  const changed = await prisma.pullRequest.updateMany({ where: { id: pullRequestId, ...(headSha !== undefined ? { headSha } : {}), ...(reviewRequestVersion !== undefined ? { reviewRequestVersion } : {}) }, data: { status: "pending" } });
  if (!changed.count) return;
  // The retry re-executes under the SAME frozen run, not live configuration --
  // dropping this here would let a label-selected model silently change on
  // the retry. rayf P-0007 C3.
  const jobId = await enqueueAfter("process-review", reviewRunId ? { pullRequestId, reviewRunId } : { pullRequestId }, 30);
  if (!jobId) throw new Error("Could not enqueue review after repository preparation");
}
