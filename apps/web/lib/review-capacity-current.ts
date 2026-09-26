import "server-only";
import { prisma } from "@octopus/db";
import { getOrgSpendLimitStatus } from "./cost";

/** Recheck the current claim and remote revisions without re-resolving the admitted model. */
export async function confirmCompleteReviewCurrent(input: {
  pullRequestId: string; orgId: string; repoId: string; model: string;
  headSha: string; baseSha: string; reviewRequestVersion: number;
  fetchRevision: (signal: AbortSignal) => Promise<{ headSha: string; baseSha: string | null }>;
}, signal: AbortSignal): Promise<"stale-review" | "billing-blocked" | null> {
  signal.throwIfAborted();
  // A remote fetch can consume most of the preflight window. Read the claim after it finishes.
  const details = await input.fetchRevision(signal);
  signal.throwIfAborted();
  if (details.headSha !== input.headSha || details.baseSha !== input.baseSha) return "stale-review";
  const spend = await getOrgSpendLimitStatus(input.orgId, input.repoId, { model: input.model, provider: "anthropic" });
  signal.throwIfAborted();
  const current = await prisma.pullRequest.findFirst({ where: { id: input.pullRequestId, status: "reviewing", headSha: input.headSha,
    reviewRequestVersion: input.reviewRequestVersion },
    select: { id: true, repository: { select: { organization: { select: { reviewsPaused: true } } } } } });
  signal.throwIfAborted();
  if (!current || current.repository.organization.reviewsPaused) return "stale-review";
  return spend.blocked ? "billing-blocked" : null;
}
