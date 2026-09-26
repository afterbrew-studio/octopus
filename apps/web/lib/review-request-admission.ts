import "server-only";
import crypto from "node:crypto";
import { prisma, Prisma, type PullRequest } from "@octopus/db";
import * as github from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";
import * as forgejo from "@/lib/forgejo";
import { loadQueueConfig, computeStaleReclaimMs } from "@/lib/queue";

export type ReviewRequestParams = {
  provider: "github" | "bitbucket" | "gitlab" | "forgejo";
  installationId?: number;
  organizationId?: string;
  repoFullName: string;
  repoId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  headSha: string | null;
  automatic?: boolean;
  triggerCommentId: number | bigint | null;
  triggerCommentBody: string | null;
};

export type ReviewRequestRejection = {
  started: false;
  reason: "already_reviewed" | "stale_head" | "head_unavailable" | "already_in_progress" | "request_contended";
  message: string;
};

/**
 * Creates the frozen `ReviewRun` this admission produces, as part of the SAME
 * atomic write as the pull request's own create/update -- not a separate step
 * after admission returns. A run-less `pending` row is exactly what a crash,
 * or an ambiguous `reviewRun.create` failure, would otherwise leave behind:
 * the pending-row reaper (`reap-stuck-reviews.ts`) deliberately skips a row
 * with no run to address, so nothing would ever recover it.
 *
 * Called with the SAME write client the pull request's own statement used
 * (a short transaction of admission's own, or an already-open ambient one),
 * and the DEFINITIVE identity admission settled on -- not the caller's
 * tentative input, which admission may have superseded (a resolved head
 * where the caller had none, an incremented version).
 */
export type CreateRunForAdmission = (
  write: Prisma.TransactionClient,
  pullRequestId: string,
  headSha: string,
  reviewRequestVersion: number,
) => Promise<{ id: string }>;

type AdmissionResult = { started: true; pullRequest: PullRequest; reviewRun: { id: string } } | ReviewRequestRejection;

/**
 * When a review in flight is presumed dead.
 *
 * Must exceed the model call's own ceiling. At three minutes it did not: a
 * legitimate strong-tier review runs longer than that, so the watchdog declared
 * it stuck and started another while the first was still going - which is how
 * one review became four attempts on rayf #646. A watchdog shorter than the
 * work it supervises does not detect stalls, it manufactures them.
 *
 * Derived from `GATEWAY_TIMEOUT_MS` so the two cannot drift apart: once the call
 * has exceeded its own timeout it has already failed, and only then is there
 * nothing left to wait for.
 */
export function stuckReviewMs(): number {
  const explicit = Number(process.env.STUCK_REVIEW_MS ?? NaN);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const gateway = Number(process.env.GATEWAY_TIMEOUT_MS ?? 150_000);
  const base = Number.isFinite(gateway) && gateway > 0 ? gateway : 150_000;
  return base + 120_000;
}

async function currentProviderHead(params: ReviewRequestParams): Promise<string | null> {
  const [owner, repo] = params.repoFullName.split("/");
  let details;
  if (params.provider === "github" && params.installationId) {
    details = await github.getPullRequestDetails(params.installationId, owner, repo, params.prNumber);
  } else if (params.provider === "bitbucket" && params.organizationId) {
    details = await bitbucket.getPullRequestDetails(params.organizationId, owner, repo, params.prNumber);
  } else if (params.provider === "gitlab" && params.organizationId) {
    details = await gitlab.getPullRequestDetails(params.organizationId, params.repoFullName, params.prNumber);
  } else if (params.provider === "forgejo" && params.organizationId) {
    details = await forgejo.getPullRequestDetails(params.organizationId, params.repoFullName, params.prNumber);
  } else {
    throw new Error("Invalid provider configuration");
  }
  return details.headSha || null;
}

/**
 * A client already inside an ambient transaction (Forgejo's own) cannot open
 * another -- Prisma does not support nesting, and everything here is already
 * atomic with it. The plain client needs a short transaction of its own so
 * the pull request's write and the run addressing it commit, or roll back,
 * together; reference equality against the module's own singleton is how the
 * two are told apart, since a real ambient transaction is never that same
 * object.
 */
async function withRunCreated<T>(
  client: Prisma.TransactionClient,
  run: (write: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return (client as unknown) === prisma ? prisma.$transaction((tx) => run(tx)) : run(client);
}

/** Validate provider head before atomically replacing the current request. */
export async function admitReviewRequest(
  params: ReviewRequestParams,
  client: Prisma.TransactionClient = prisma,
  createRun: CreateRunForAdmission,
): Promise<AdmissionResult> {
  return params.provider === "forgejo"
    ? forgejo.runWithForgejoRepository(params.repoId, () => admitReviewRequestInternal(params, client, createRun))
    : admitReviewRequestInternal(params, client, createRun);
}

async function admitReviewRequestInternal(params: ReviewRequestParams, client: Prisma.TransactionClient, createRun: CreateRunForAdmission): Promise<AdmissionResult> {
  const automatic = params.provider === "forgejo" && params.automatic === true;
  const where = { repositoryId_number: { repositoryId: params.repoId, number: params.prNumber } };
  // A "queued" pull request whose latest run is ALSO marked "queued" is a
  // large-review handoff to internal-cli (clone + claude-cli), which
  // legitimately runs far longer than an in-process review -- the generic,
  // gateway-derived `stuckReviewMs()` window (~4.5 minutes by default) is sized
  // for THAT case, not for a large review's `largeReviewTimeoutSeconds` (30
  // minutes by default). Applying it to "queued" too would let a manual retry
  // "reset" a large review that is still legitimately running and let a second
  // worker claim it out from under the first.
  //
  // "queued" is not exclusive to large reviews, though: a low-balance or
  // repository-preparation deferral also parks the pull request at "queued"
  // for a few seconds while the same run waits to re-enqueue. Those never mark
  // the run itself "queued" (see `reviewer.ts`'s large-review handoff), so
  // they fall through to the short window below instead.
  const queuedStuckMs = computeStaleReclaimMs((await loadQueueConfig()).largeReviewTimeoutSeconds);
  for (let attempt = 0; attempt < 3; attempt++) {
    // Capture the DB state before the remote read. A competing request that
    // wins while that read is in flight must force a fresh provider read.
    const existing = await client.pullRequest.findUnique({
      where,
      select: {
        id: true, status: true, headSha: true, reviewRequestVersion: true, updatedAt: true,
        attempts: { orderBy: { createdAt: "desc" }, take: 1, select: { state: true } },
      },
    });
    const headSha = await currentProviderHead(params);
    if (!headSha) {
      return { started: false, reason: "head_unavailable", message: "The provider did not return a current pull request head" };
    }
    if (params.headSha && params.headSha !== headSha) {
      return { started: false, reason: "stale_head", message: `PR #${params.prNumber} has moved to a different head` };
    }
    if (automatic && existing && ((existing.headSha === headSha && existing.status === "completed")
      || await client.reviewAttempt.findFirst({ where: { pullRequestId: existing.id, headSha }, select: { id: true } }))) {
      return { started: false, reason: "already_reviewed", message: `PR #${params.prNumber} has already been reviewed at this head` };
    }
    const isGenuineLargeReviewQueue = !!existing && existing.status === "queued" && existing.attempts[0]?.state === "queued";
    if (existing && existing.headSha === headSha
      && ["reviewing", "pending", "queued"].includes(existing.status)
      && (automatic || Date.now() - existing.updatedAt.getTime() <= (isGenuineLargeReviewQueue ? queuedStuckMs : stuckReviewMs()))) {
      return { started: false, reason: "already_in_progress", message: `Review already in progress for PR #${params.prNumber}` };
    }

    const data = {
      title: params.prTitle,
      url: params.prUrl,
      author: params.prAuthor,
      headSha,
      status: "pending",
      triggerCommentId: params.triggerCommentId,
      triggerCommentBody: params.triggerCommentBody,
    };
    if (!existing) {
      // Pre-generated so the run created in the SAME atomic write can
      // address it by id -- `create()`'s own generated id isn't known
      // until after, and the write must not be split into two.
      const pullRequestId = crypto.randomUUID();
      try {
        const { pullRequest, reviewRun } = await withRunCreated(client, async (write) => {
          const pullRequest = await write.pullRequest.create({ data: {
            id: pullRequestId, ...data, repositoryId: params.repoId, number: params.prNumber, reviewRequestVersion: 1,
          } });
          const reviewRun = await createRun(write, pullRequest.id, headSha, 1);
          return { pullRequest, reviewRun };
        });
        return { started: true, pullRequest, reviewRun };
      } catch (error) {
        // A concurrent first request created the unique repository/PR row.
        // The short transaction above rolled back cleanly on this error --
        // `client` (used for the retry read next iteration) was never part
        // of it, so it is not the aborted transaction a nested one would be.
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") continue;
        throw error;
      }
    }

    // UPDATE ... RETURNING keeps the accepted snapshot and its version
    // together. Forgejo callers also wrap admission and enqueue in a transaction.
    const { pullRequest, reviewRun } = await withRunCreated(client, async (write) => {
      const [pullRequest] = await write.pullRequest.updateManyAndReturn({
        where: {
          id: existing.id, headSha: existing.headSha, reviewRequestVersion: existing.reviewRequestVersion,
          status: existing.status, updatedAt: existing.updatedAt,
          ...(automatic ? { reviewAttempts: { none: { headSha } } } : {}),
        },
        data: {
          ...data, reviewRequestVersion: { increment: 1 }, reviewBody: null,
          reviewCoverage: Prisma.DbNull, errorMessage: null,
        },
      });
      if (!pullRequest) return { pullRequest: undefined, reviewRun: undefined };
      const reviewRun = await createRun(write, pullRequest.id, headSha, pullRequest.reviewRequestVersion);
      return { pullRequest, reviewRun };
    });
    if (pullRequest) return { started: true, pullRequest, reviewRun: reviewRun! };
  }
  return { started: false, reason: "request_contended", message: "The review request changed during admission; retry the request" };
}
