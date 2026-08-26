import { prisma } from "@octopus/db";
import { pubby } from "@/lib/pubby";
import { enqueue } from "@/lib/queue";
import { eventBus } from "@/lib/events";
import * as github from "@/lib/github";
import * as bitbucket from "@/lib/bitbucket";
import * as gitlab from "@/lib/gitlab";
import { mayStartReview, reviewRefusalMessage, type ReviewSource } from "@/lib/review-start-policy";
// The same helpers reviewer.ts uses, so the snapshot cannot drift from the
// merge the worker would otherwise have performed itself.
import { mergeReviewConfigs, parseReviewConfig } from "@/lib/review-helpers";

/**
 * Post a neutral "skipped" check run so the PR isn't blocked forever.
 * GitHub only — Bitbucket and GitLab have no equivalent checks API in this integration.
 */
async function postSkippedCheckRun(
  provider: "github" | "bitbucket" | "gitlab",
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
 * Shared flow: upsert PR -> post placeholder comment -> notify dashboard -> start review.
 * Works for GitHub, Bitbucket, and GitLab.
 */
export async function startReviewFlow(params: {
  /** Who is asking. Required: a default would let a new call site start reviews silently. */
  source: ReviewSource;
  /** The dispatcher's id for this request, so a paid review is attributable to one ask. */
  correlationId?: string;
  provider: "github" | "bitbucket" | "gitlab";
  // GitHub-specific
  installationId?: number;
  // Bitbucket / GitLab-specific
  organizationId?: string;
  // Common
  repoFullName: string;
  repoId: string;
  orgId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  prAuthor: string;
  headSha: string;
  triggerCommentId: number;
  triggerCommentBody: string;
}) {
  // Before every side effect -- no upsert, placeholder comment, check run,
  // dashboard notification or enqueue happens for a refused caller, which is what
  // "side-effect-free" means in P-0007 C2.
  //
  // Returns rather than throws: none of the six webhook routes catches, so a throw
  // is a 500 and the provider retries the delivery. See review-start-policy.ts.
  if (!mayStartReview(params.source)) {
    console.log(
      "[webhook] " +
        reviewRefusalMessage(
          params.source,
          `${params.provider} pr #${params.prNumber} on ${params.repoFullName}`,
        ),
    );
    return;
  }

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
    triggerCommentId,
    triggerCommentBody,
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
    return;
  }

  // Check existing PR status to prevent duplicate reviews (cheap indexed lookup first)
  const existingPr = await prisma.pullRequest.findUnique({
    where: {
      repositoryId_number: { repositoryId: repoId, number: prNumber },
    },
    select: { id: true, status: true, headSha: true, updatedAt: true },
  });

  if (existingPr && (existingPr.status === "reviewing" || existingPr.status === "pending")) {
    const stuckThresholdMs = 3 * 60 * 1000; // 3 minutes
    const isStuck = Date.now() - existingPr.updatedAt.getTime() > stuckThresholdMs;

    if (isStuck) {
      console.log(`[webhook] Review for PR #${prNumber} stuck for >3min, marking as failed and restarting`);
      await prisma.pullRequest.update({
        where: { id: existingPr.id },
        data: { status: "failed", errorMessage: "Review timed out after 3 minutes" },
      });
    } else if (existingPr.headSha === headSha) {
      console.log(`[webhook] Review already in progress/queued for PR #${prNumber} (same SHA), skipping`);
      return;
    } else {
      console.log(`[webhook] New SHA detected for PR #${prNumber}, restarting review`);
    }
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
      await postSkippedCheckRun(provider, installationId, repoFullName, headSha, `PR author "${prAuthor}" is in the blocked list`);
      return;
    }
  }

  // Upsert PullRequest record
  console.log(`[webhook] Upserting PullRequest — repo: ${repoId}, PR #${prNumber}, status: pending`);
  const pr = await prisma.pullRequest.upsert({
    where: {
      repositoryId_number: { repositoryId: repoId, number: prNumber },
    },
    create: {
      number: prNumber,
      title: prTitle,
      url: prUrl,
      author: prAuthor,
      headSha: headSha || null,
      status: "pending",
      triggerCommentId,
      triggerCommentBody,
      repositoryId: repoId,
    },
    update: {
      title: prTitle,
      url: prUrl,
      author: prAuthor,
      headSha: headSha || null,
      status: "pending",
      triggerCommentId,
      triggerCommentBody,
      reviewBody: null,
      errorMessage: null,
    },
  });
  console.log(`[webhook] PullRequest upserted — id: ${pr.id}, number: ${pr.number}`);

  const existingCommentId = pr.reviewCommentId ? Number(pr.reviewCommentId) : null;
  const placeholderBody =
    "> 🐙 **Octopus Review** is analyzing this pull request...\n>\n> This comment will be updated with the full review once complete.";

  // Post or update placeholder comment
  try {
    if (existingCommentId) {
      console.log(`[webhook] Updating existing placeholder comment — commentId: ${existingCommentId}`);
      if (provider === "github" && installationId) {
        await github.updatePullRequestComment(installationId, owner, repoName, existingCommentId, placeholderBody);
      } else if (provider === "bitbucket" && organizationId) {
        await bitbucket.updatePullRequestComment(organizationId, owner, repoName, prNumber, existingCommentId, placeholderBody);
      } else if (provider === "gitlab" && organizationId) {
        await gitlab.updatePullRequestComment(organizationId, repoFullName, prNumber, existingCommentId, placeholderBody);
      }
    } else {
      console.log(`[webhook] Posting new placeholder comment to PR #${prNumber}`);
      let newCommentId: number;
      if (provider === "github" && installationId) {
        newCommentId = await github.createPullRequestComment(installationId, owner, repoName, prNumber, placeholderBody);
      } else if (provider === "bitbucket" && organizationId) {
        newCommentId = await bitbucket.createPullRequestComment(organizationId, owner, repoName, prNumber, placeholderBody);
      } else if (provider === "gitlab" && organizationId) {
        newCommentId = await gitlab.createPullRequestComment(organizationId, repoFullName, prNumber, placeholderBody);
      } else {
        throw new Error("Invalid provider configuration");
      }
      console.log(`[webhook] Placeholder comment posted — commentId: ${newCommentId}`);
      await prisma.pullRequest.update({
        where: { id: pr.id },
        data: { reviewCommentId: newCommentId },
      });
    }
  } catch (err) {
    console.error("[webhook] Failed to post/update placeholder comment:", err);
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

  // Freeze the attempt BEFORE enqueueing.
  //
  // `processReview` merges its configuration from three mutable sources at
  // execution time -- system, organization and repository -- so a change to any of
  // them between enqueue and execution silently changes the review that runs. What
  // executed would not be what was approved, and the record of it would be
  // unreliable in exactly the case anyone would want to audit.
  //
  // Snapshotting here and addressing the attempt id downstream is rayf P-0007 C3.
  // The merge order must match the one in reviewer.ts; `mergeReviewConfigs` is
  // shared so the two cannot drift apart silently.
  const [sysRow, orgRow, repoRow] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { defaultReviewConfig: true } }),
    prisma.organization.findUnique({ where: { id: orgId }, select: { defaultReviewConfig: true } }),
    prisma.repository.findUnique({ where: { id: repoId }, select: { reviewConfig: true } }),
  ]);
  const configSnapshot = mergeReviewConfigs(
    sysRow ? parseReviewConfig(sysRow.defaultReviewConfig) : {},
    parseReviewConfig(orgRow?.defaultReviewConfig),
    parseReviewConfig(repoRow?.reviewConfig),
  );

  const attempt = await prisma.reviewAttempt.create({
    data: {
      pullRequestId: pr.id,
      source: params.source,
      correlationId: params.correlationId ?? null,
      headSha: headSha || null,
      provider,
      configSnapshot: configSnapshot as object,
      state: "pending",
    },
    select: { id: true },
  });

  // Enqueue review job — pg-boss persists it in DB, survives container restarts.
  // The attempt id travels with it so the worker reads the frozen decision rather
  // than re-resolving live configuration.
  await enqueue("process-review", { pullRequestId: pr.id, attemptId: attempt.id });
}
