import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { admitReviewRequest, type ReviewRequestRejection } from "@/lib/review-request-admission";
import { createReviewAttemptComment } from "@/lib/review-attempt";
import { publishReviewSummary } from "@/lib/review-summary-comment";
import { pubby } from "@/lib/pubby";
import { enqueue } from "@/lib/queue";
import { eventBus } from "@/lib/events";
import * as github from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";
import * as forgejo from "@/lib/forgejo";
import { mayStartReview, reviewRefusalMessage, type ReviewSource } from "@/lib/review-start-policy";
// The same helpers reviewer.ts uses, so the snapshot cannot drift from the
// merge the worker would otherwise have performed itself.
import { mergeReviewConfigs, parseReviewConfig } from "@/lib/review-helpers";

/**
 * Post a neutral "skipped" check run so the PR isn't blocked forever.
 * GitHub only — Bitbucket and GitLab have no equivalent checks API in this integration.
 */
async function postSkippedCheckRun(
  provider: "github" | "bitbucket" | "gitlab" | "forgejo",
  installationId: number | undefined,
  repoFullName: string,
  headSha: string,
  reason: string,
) {
  if (provider !== "github" || !installationId || !headSha) return;
  const [owner, repo] = repoFullName.split("/");
  try {
    const checkRunId = await github.createCheckRun(installationId, owner, repo, headSha, "Octopus Review");
    await github.updateCheckRun(installationId, owner, repo, checkRunId, "neutral", {
      title: "Review skipped",
      summary: reason,
    });
    console.log(`[webhook] Check run marked as neutral — ${reason}`);
  } catch (err) {
    console.warn("[webhook] Failed to post neutral check run:", err);
  }
}

/**
 * Forgejo webhooks use the outcome to retry transient admission failures.
 * User-facing triggers (CLI / MCP) use it to explain why nothing ran.
 */
export type StartReviewResult =
  | { started: true; pullRequestId: string }
  | ReviewRequestRejection
  | { started: false; reason: "org_paused" | "author_blocked" | "source_not_allowed"; message: string };

type StartReviewParams = {
  /** Who is asking. Required: a default would let a new call site start reviews silently. */
  source: ReviewSource;
  /** The dispatcher's id for this request, so a paid review is attributable to one ask. */
  correlationId?: string;
  /**
   * A model the caller has chosen for this review, overriding the repository's usual one.
   * Recorded in `configSnapshot` rather than passed separately, so the ledger says which
   * model a paid review was asked to use and not merely which one it ended up on.
   */
  modelOverride?: string;
  provider: "github" | "bitbucket" | "gitlab" | "forgejo";
  // GitHub-specific
  installationId?: number;
  // Bitbucket / GitLab / Forgejo-specific
  organizationId?: string;
  // Common
  repoFullName: string;
  repoId: string;
  orgId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  headSha: string | null;
  automatic?: boolean;
  triggerCommentId: number;
  triggerCommentBody: string;
};

/**
 * Shared flow: admit the current head -> post placeholder comment -> notify dashboard -> start review.
 * Forgejo queues within the admission transaction; its worker posts the placeholder.
 */
export async function startReviewFlow(params: StartReviewParams, forgejoTransaction?: Prisma.TransactionClient): Promise<StartReviewResult> {
  // Before every side effect -- no upsert, placeholder comment, check run,
  // dashboard notification or enqueue happens for a refused caller, which is what
  // "side-effect-free" means in P-0007 C2.
  //
  // Returns rather than throws: none of the six webhook routes catches, so a throw
  // is a 500 and the provider retries the delivery. See review-start-policy.ts.
  if (!mayStartReview(params.source)) {
    const message = reviewRefusalMessage(
      params.source,
      `${params.provider} pr #${params.prNumber} on ${params.repoFullName}`,
    );
    console.log(`[webhook] ${message}`);
    return { started: false, reason: "source_not_allowed", message };
  }

  if (forgejoTransaction && params.provider !== "forgejo") throw new Error("Transactional webhook admission requires Forgejo");
  return params.provider === "forgejo"
    ? forgejo.runWithForgejoRepository(params.repoId, () => startReviewFlowInternal(params, forgejoTransaction))
    : startReviewFlowInternal(params, forgejoTransaction);
}

async function startReviewFlowInternal(params: StartReviewParams, forgejoTransaction?: Prisma.TransactionClient): Promise<StartReviewResult> {
  const {
    provider,
    installationId,
    organizationId,
    repoFullName,
    repoId,
    orgId,
    prNumber,
    prTitle,
    prUrl,
    prAuthor,
    headSha,
  } = params;

  const [owner, repoName] = repoFullName.split("/");

  // Check if reviews are paused for this organization
  const [org, systemConfig] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: orgId },
      select: { reviewsPaused: true, blockedAuthors: true },
    }),
    prisma.systemConfig.findUnique({
      where: { id: "singleton" },
      select: { blockedAuthors: true },
    }),
  ]);

  if (org?.reviewsPaused) {
    console.log(`[webhook] Reviews paused for org ${orgId}, skipping PR #${prNumber}`);
    return { started: false, reason: "org_paused", message: "Reviews are paused for this organization" };
  }

  // Check if PR author is blocked from triggering reviews
  if (prAuthor) {
    const globalBlocked = (systemConfig?.blockedAuthors as string[]) ?? [];
    const orgBlocked = (org?.blockedAuthors as string[]) ?? [];
    const authorLower = prAuthor.toLowerCase();
    const isBlocked = [...globalBlocked, ...orgBlocked].some(
      (b) => b.toLowerCase() === authorLower,
    );
    if (isBlocked) {
      console.log(`[webhook] PR author "${prAuthor}" is blocked for org ${orgId}, skipping PR #${prNumber}`);
      await postSkippedCheckRun(provider, installationId, repoFullName, headSha || "", `PR author "${prAuthor}" is in the blocked list`);
      return { started: false, reason: "author_blocked", message: `PR author "${prAuthor}" is in the blocked list` };
    }
  }

  const admission = await admitReviewRequest(params, forgejoTransaction);
  if (!admission.started) return admission;
  const pr = admission.pullRequest;
  console.log(`[webhook] PullRequest admitted — id: ${pr.id}, number: ${pr.number}`);

  // Freeze the run BEFORE enqueueing, on every provider path -- Forgejo's
  // transactional early return below used to enqueue with no run at all, so
  // every Forgejo review ran on live configuration. See the fuller rationale
  // further down, where the non-Forgejo path used to do this alone.
  //
  // Freezes `pr.headSha`/`pr.reviewRequestVersion` -- admission's OWN
  // returned pull request -- not the caller's input params. Admission
  // accepts an empty/null input head and resolves the authoritative one
  // itself (`currentProviderHead`); freezing the input would bind the run to
  // a head nobody actually reviewed at, and the worker would immediately
  // find that frozen (null) head not matching the real one and finalize the
  // run superseded before ever claiming it.
  let reviewRun: { id: string };
  if (forgejoTransaction) {
    // Forgejo's admission already runs inside this ambient transaction, and
    // freeze joins it -- unchanged from the prior pass.
    reviewRun = await freezeReviewRun(pr.id, pr.headSha, { ...params, reviewRequestVersion: pr.reviewRequestVersion, client: forgejoTransaction });
  } else {
    try {
      reviewRun = await freezeReviewRun(pr.id, pr.headSha, { ...params, reviewRequestVersion: pr.reviewRequestVersion });
    } catch (err) {
      // Wrapping every provider's admission in its own transaction (as a
      // prior pass did) broke two things admission itself relies on: its
      // provider API call would hold that transaction open for as long as
      // the provider takes to respond, risking Prisma's own transaction
      // timeout; and its concurrent-create P2002 recovery re-queries on the
      // SAME transaction, which PostgreSQL has already aborted after that
      // error, turning two concurrent first admissions into a transaction
      // failure instead of `already_in_progress`. Admission commits on its
      // own here, same as before that pass, and a freeze failure instead
      // reverts it -- guarded on the exact identity admission just
      // produced -- so this row is retryable rather than stranded `pending`
      // with no run and no job.
      await prisma.pullRequest.updateMany({
        where: { id: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion, status: "pending" },
        data: { status: "failed", errorMessage: "Review could not be frozen. Retry the request." },
      }).catch((e) => console.error("[webhook] Failed to revert admission after freeze failure:", e));
      throw err;
    }
  }

  if (forgejoTransaction) {
    const jobId = await enqueue("process-review", { pullRequestId: pr.id, reviewRunId: reviewRun.id }, {
      db: { executeSql: async (sql, values) => ({ rows: await forgejoTransaction.$queryRawUnsafe<unknown[]>(sql, ...(values ?? [])) }) },
    });
    if (!jobId) throw new Error("Forgejo review could not be queued");
    return { started: true, pullRequestId: pr.id };
  }

  const placeholderBody = `> 🐙 **Octopus Review** is queued for head \`${pr.headSha || "unknown"}\`. This summary will update when the review finishes.`;
  try {
    if (provider === "github" && installationId) {
      await publishReviewSummary({ pullRequestId: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion,
        installationId, owner, repo: repoName, prNumber, body: placeholderBody });
    } else await createReviewAttemptComment(pr.id, pr.headSha, pr.reviewRequestVersion, async () => {
      if (provider === "bitbucket" && organizationId) {
        return bitbucket.createPullRequestComment(organizationId, owner, repoName, prNumber, placeholderBody);
      }
      if (provider === "gitlab" && organizationId) {
        return gitlab.createPullRequestComment(organizationId, repoFullName, prNumber, placeholderBody);
      }
      if (provider === "forgejo" && organizationId) {
        return forgejo.createPullRequestComment(organizationId, repoFullName, prNumber, placeholderBody);
      }
      throw new Error("Invalid provider configuration");
    });
  } catch (err) {
    console.error("[webhook] Failed to post placeholder comment:", err);
  }

  // Notify real-time dashboard
  const channel = `presence-org-${orgId}`;
  pubby
    .trigger(channel, "review-requested", {
      repoId,
      pullRequest: {
        id: pr.id,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        status: pr.status,
        headSha: pr.headSha,
        reviewRequestVersion: pr.reviewRequestVersion,
        createdAt: pr.createdAt.toISOString(),
      },
    })
    .catch((err) => console.error("[webhook] Pubby trigger failed:", err));

  eventBus.emit({
    type: "review-requested",
    orgId,
    prNumber,
    prTitle,
    prAuthor,
    prUrl,
  });

  // Enqueue review job — pg-boss persists it in DB, survives container restarts.
  // The run id travels with it so the worker reads the frozen decision rather
  // than re-resolving live configuration.
  try {
    await enqueue("process-review", { pullRequestId: pr.id, reviewRunId: reviewRun.id });
  } catch (error) {
    // Release only this admission. A provider retry must not be suppressed as
    // already in progress when the durable queue never accepted the job.
    if (provider === "forgejo") await prisma.pullRequest.updateMany({
      where: { id: pr.id, headSha: pr.headSha, reviewRequestVersion: pr.reviewRequestVersion, status: "pending" },
      data: { status: "failed", errorMessage: "Review could not be queued. Retry the request." },
    });
    throw error;
  }
  return { started: true, pullRequestId: pr.id };
}

/**
 * Freeze the run BEFORE enqueueing, for every provider path -- including the
 * Forgejo transactional one, whose early return in `startReviewFlowInternal`
 * used to enqueue with no run at all, so every Forgejo review ran on live
 * configuration instead of what was approved.
 *
 * `processReview` merges its configuration from three mutable sources at
 * execution time -- system, organization and repository -- so a change to any of
 * them between enqueue and execution silently changes the review that runs. What
 * executed would not be what was approved, and the record of it would be
 * unreliable in exactly the case anyone would want to audit.
 *
 * Snapshotting here and addressing the run id downstream is rayf P-0007 C3.
 * The merge order must match the one in reviewer.ts; `mergeReviewConfigs` is
 * shared so the two cannot drift apart silently.
 *
 * Throws rather than falling back to live configuration on failure, matching
 * every other step of admission: none of the six webhook routes catches, so a
 * throw here is a 500 and the provider retries the delivery. Swallowing it
 * would enqueue a review nobody approved -- which is exactly what freezing
 * exists to prevent -- to save a retry the provider already does for free.
 */
export async function freezeReviewRun(pullRequestId: string, headSha: string | null, params: {
  source: StartReviewParams["source"];
  correlationId?: string;
  modelOverride?: string;
  provider: string;
  orgId: string;
  repoId: string;
  prNumber: number;
  // The pull request's own version at the moment this run was frozen. An
  // execution later checks both this and `headSha` against the pull
  // request's CURRENT values -- a run whose request has since moved to a
  // different head or a different version at the same head is superseded,
  // not a continuation of it.
  reviewRequestVersion: number;
  // The pull request row this run's foreign key points at may exist only
  // inside an open transaction on another connection (Forgejo's admission is
  // transactional). Reading/writing through the global `prisma` client in
  // that case blocks on -- or, if the transaction later rolls back, orphans a
  // pending run against -- a row the global connection cannot yet see.
  client?: Pick<Prisma.TransactionClient, "systemConfig" | "organization" | "repository" | "reviewRun">;
}): Promise<{ id: string }> {
  const client = params.client ?? prisma;
  const [sysRow, orgRow, repoRow] = await Promise.all([
    client.systemConfig.findUnique({ where: { id: "singleton" }, select: { defaultReviewConfig: true } }),
    client.organization.findUnique({ where: { id: params.orgId }, select: { defaultReviewConfig: true } }),
    client.repository.findUnique({ where: { id: params.repoId }, select: { reviewConfig: true } }),
  ]);
  // Only the `label` caller resolves a model: it is the only event carrying the
  // label that was just added. A push, an `@octopus` mention and the stuck-review
  // restart above all pass none, so the review drops to the deployment default
  // and a `complexity:strong` change gets its strong reviewer once and the mid
  // tier for the rest of its life - the declaration buying nothing.
  //
  // Carried forward from the last run rather than re-read here, because
  // `octopus.json` is read from the DEFAULT branch so a pull request cannot pick
  // its own reviewer. Re-deriving at this point would have to trust the event.
  const inheritedModel = params.modelOverride ?? (await lastResolvedModel(pullRequestId, client));
  const configSnapshot = mergeReviewConfigs(
    sysRow ? parseReviewConfig(sysRow.defaultReviewConfig) : {},
    parseReviewConfig(orgRow?.defaultReviewConfig),
    parseReviewConfig(repoRow?.reviewConfig),
    inheritedModel ? { modelOverride: inheritedModel } : {},
  );
  if (!params.modelOverride && inheritedModel) {
    console.log(
      `[webhook] PR #${params.prNumber} inherits model ${inheritedModel} from its last run (source: ${params.source})`,
    );
  }

  return client.reviewRun.create({
    data: {
      pullRequestId,
      source: params.source,
      correlationId: params.correlationId ?? null,
      headSha: headSha || null,
      reviewRequestVersion: params.reviewRequestVersion,
      provider: params.provider,
      configSnapshot: configSnapshot as object,
      state: "pending",
    },
    select: { id: true },
  });
}

/**
 * The model the most recent run on this pull request was asked to use.
 *
 * Undefined when no run ever recorded one, which is the ordinary case for a
 * repository that does not key models on labels: the caller falls through to the
 * deployment default exactly as before.
 */
async function lastResolvedModel(pullRequestId: string, client: Pick<Prisma.TransactionClient, "reviewRun"> = prisma): Promise<string | undefined> {
  // Soft: inheriting a model is a routing improvement, not a correctness gate.
  // A read that fails here must not stop the review from starting - the cost of
  // losing it is the deployment default, the cost of throwing is no review.
  let previous: { configSnapshot: unknown } | null = null;
  try {
    previous = await client.reviewRun.findFirst({
      where: { pullRequestId },
      orderBy: { createdAt: "desc" },
      select: { configSnapshot: true },
    });
  } catch (err) {
    console.warn("[webhook] could not read the last run's model:", err);
    return undefined;
  }
  const snapshot = previous?.configSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return undefined;
  const model = (snapshot as { modelOverride?: unknown }).modelOverride;
  return typeof model === "string" && model.trim() !== "" ? model : undefined;
}

// Re-exported so existing importers (including its own test) keep one home for
// this name; the value now lives in review-request-admission.ts, which also
// needs it and cannot import it back from here without a cycle.
export { stuckReviewMs } from "@/lib/review-request-admission";
