import "server-only";
import { authenticateApiToken } from "@/lib/api-auth";
import { prisma } from "@octopus/db";
import * as github from "@/lib/github";
import * as gitlab from "@/lib/gitlab";
import * as forgejo from "@/lib/forgejo";
import * as bitbucket from "@/lib/bitbucket";
import { startReviewFlow } from "@/lib/webhook-shared";
import { NextRequest } from "next/server";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const result = await authenticateApiToken(request);
  if (result instanceof Response) return result; // account-standing hold (403), pass through
  if (!result) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const repo = await prisma.repository.findFirst({
    where: { id, organizationId: result.org.id, isActive: true },
  });

  if (!repo) {
    return Response.json({ error: "Repository not found" }, { status: 404 });
  }

  const { prNumber, correlationId } = await request.json();
  if (!prNumber) {
    return Response.json({ error: "Missing prNumber" }, { status: 400 });
  }

  // Provider-aware wording: GitLab calls them "merge requests".
  const prLabel = repo.provider === "gitlab" ? "Merge request" : "Pull request";

  // Refresh provider details for both existing and newly discovered PRs.
  // Shared admission validates that head again after taking its DB snapshot.
  const parts = repo.fullName.split("/");
  if (parts.length < 2) {
    return Response.json({ error: "Invalid repository name" }, { status: 500 });
  }
  const [owner, repoName] = parts;
  const installationId = repo.installationId ?? result.org.githubInstallationId;
  try {
    let details;
    if (repo.provider === "github") {
      if (!installationId) throw new Error("Missing installation id");
      details = await github.getPullRequestDetails(installationId, owner, repoName, prNumber);
    } else if (repo.provider === "gitlab") {
      details = await gitlab.getPullRequestDetails(result.org.id, repo.fullName, prNumber);
    } else if (repo.provider === "forgejo") {
      details = await forgejo.runWithForgejoRepository(repo.id, () => forgejo.getPullRequestDetails(result.org.id, repo.fullName, prNumber));
    } else if (repo.provider === "bitbucket") {
      details = await bitbucket.getPullRequestDetails(result.org.id, owner, repoName, prNumber);
    } else {
      return Response.json({ error: `${prLabel} not found` }, { status: 404 });
    }

    // One path for every case. This branch used to call `processReview` directly
    // when the pull request was already known, which skipped `startReviewFlow` --
    // and with it the attempt record. Every review started that way ran on live
    // configuration and left nothing attributable behind, which is the property
    // the attempt exists to provide. rayf#122.
    const outcome = await startReviewFlow({
      source: "adapter",
      ...(correlationId ? { correlationId: String(correlationId) } : {}),
      provider: repo.provider as "github" | "gitlab" | "bitbucket" | "forgejo",
      installationId: installationId ?? undefined,
      organizationId: result.org.id,
      repoFullName: repo.fullName,
      repoId: repo.id,
      orgId: result.org.id,
      prNumber: details.number,
      prTitle: details.title,
      prUrl: details.url,
      prAuthor: details.author,
      headSha: details.headSha,
      triggerCommentId: 0,
      triggerCommentBody: "",
    });

    if (!outcome.started) {
      // Blocked author / paused org / duplicate: tell the caller instead of
      // claiming a review started that never will.
      const status = ["already_in_progress", "stale_head", "request_contended"].includes(outcome.reason) ? 409 : 422;
      return Response.json({ error: outcome.message, reason: outcome.reason }, { status });
    }
    return Response.json({ message: "Review started", pullRequestId: outcome.pullRequestId, prNumber: details.number });
  } catch (err) {
    console.error(`[cli] Failed to fetch ${repo.provider} ${prLabel} #${prNumber}:`, err);
    return Response.json({ error: `${prLabel} not found` }, { status: 404 });
  }
}
