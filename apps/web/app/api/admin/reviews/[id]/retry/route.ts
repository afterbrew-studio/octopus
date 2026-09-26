import "server-only";
import { pubby } from "@/lib/pubby";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@octopus/db";
import { enqueue } from "@/lib/queue";
import { admitReviewRequest } from "@/lib/review-request-admission";
import { freezeReviewRun } from "@/lib/webhook-shared";

const STALE_REVIEW_MS = 3 * 60 * 1000;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.ADMIN_API_SECRET;
  if (!expected) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === expected;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const pr = await prisma.pullRequest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      updatedAt: true,
      repositoryId: true,
      title: true,
      url: true,
      author: true,
      headSha: true,
      triggerCommentId: true,
      triggerCommentBody: true,
      repository: { select: {
        organizationId: true, provider: true, fullName: true, installationId: true,
        organization: { select: { githubInstallationId: true } },
      } },
    },
  });

  if (!pr) {
    return NextResponse.json({ error: "Pull request not found" }, { status: 404 });
  }

  // Block retry if a review is actively running (and not stuck) — pg-boss
  // already retries failed jobs, and processReview's claim logic prevents
  // duplicate workers, but enqueuing on top of an in-flight review is wasteful.
  if (pr.status === "reviewing" || pr.status === "pending" || pr.status === "queued") {
    const elapsed = Date.now() - pr.updatedAt.getTime();
    if (elapsed < STALE_REVIEW_MS) {
      return NextResponse.json(
        { error: `Review is already ${pr.status}` },
        { status: 409 },
      );
    }
  }

  const provider = pr.repository.provider;
  if (provider !== "github" && provider !== "bitbucket" && provider !== "gitlab" && provider !== "forgejo") {
    return NextResponse.json({ error: "Unsupported review provider" }, { status: 422 });
  }
  // The run is created as part of admission's OWN atomic write (a short
  // transaction admission opens itself) -- not a separate step after
  // admission returns. A crash, or an ambiguous `reviewRun.create` failure,
  // between two separate writes would otherwise leave a `pending` row with
  // no run and no job that nothing recovers: the pending-row reaper
  // (`reap-stuck-reviews.ts`) deliberately skips a row with no run to
  // address. `freezeReviewRun` is called back by admission with the write
  // client and the DEFINITIVE identity it settled on -- not `pr.headSha`,
  // which may be stale by the time admission resolves the authoritative head.
  const admission = await admitReviewRequest({
    provider,
    installationId: pr.repository.installationId ?? pr.repository.organization.githubInstallationId ?? undefined,
    organizationId: pr.repository.organizationId,
    repoFullName: pr.repository.fullName,
    repoId: pr.repositoryId,
    prNumber: pr.number,
    prTitle: pr.title,
    prUrl: pr.url,
    prAuthor: pr.author,
    headSha: pr.headSha,
    triggerCommentId: pr.triggerCommentId,
    triggerCommentBody: pr.triggerCommentBody,
  }, undefined, (write, pullRequestId, headSha, reviewRequestVersion) =>
    freezeReviewRun(write, pullRequestId, headSha, reviewRequestVersion, {
      source: "adapter",
      provider: pr.repository.provider,
      orgId: pr.repository.organizationId,
      repoId: pr.repositoryId,
      prNumber: pr.number,
    }));
  if (!admission.started) {
    return NextResponse.json({ error: admission.message, reason: admission.reason }, { status: 409 });
  }
  const requested = admission.pullRequest;
  const reviewRun = admission.reviewRun;

  await pubby.trigger(`presence-org-${pr.repository.organizationId}`, "review-requested", {
    repoId: pr.repositoryId,
    pullRequest: { id: requested.id, number: requested.number, title: requested.title, url: requested.url, author: requested.author, status: requested.status, headSha: requested.headSha, reviewRequestVersion: requested.reviewRequestVersion, createdAt: requested.createdAt.toISOString() },
  }).catch(error => console.error("[review-retry] Status publication failed:", error));

  await enqueue("process-review", { pullRequestId: pr.id, reviewRunId: reviewRun.id });

  return NextResponse.json({ message: "Review retry enqueued", pullRequestId: pr.id });
}
