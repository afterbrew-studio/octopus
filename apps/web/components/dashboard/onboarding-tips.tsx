"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { IconCircleCheck, IconCircle, IconLoader2, IconX } from "@tabler/icons-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getPubbyClient } from "@/lib/pubby-client";
import { getPreparationProgress, type RepositoryReadiness } from "@/lib/repository-onboarding";

export type OnboardingRepository = {
  id: string;
  fullName: string;
  provider: string;
  autoReview: boolean;
  indexStatus: string;
  analysisStatus: string;
  url: string | null;
  readiness: RepositoryReadiness;
};

export function OnboardingTips({
  orgId, connected, repositories, repository, latestReview, completedReview,
}: {
  orgId: string;
  connected: boolean;
  repositories: { id: string; fullName: string }[];
  repository: OnboardingRepository | null;
  latestReview: { id: string; number: number; status: string; url: string } | null;
  completedReview: { id: string; number: number; url: string } | null;
}) {
  const [dismissed, setDismissed] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const channel = getPubbyClient().subscribe(`presence-org-${orgId}`);
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => router.refresh(), 300);
    };
    const events = ["index-status", "analysis-status", "review-requested", "review-status", "repos-discovered"];
    for (const event of events) channel.bind(event, update);
    return () => {
      clearTimeout(refresh);
      for (const event of events) channel.unbind(event, update);
    };
  }, [orgId, router]);

  if (dismissed) return null;
  const complete = completedReview !== null;
  const repoHref = repository ? `/repositories?repo=${encodeURIComponent(repository.id)}` : "/repositories";
  const setupHref = repository ? `/settings/integrations#${repository.provider}` : "/settings/integrations";
  const reviewHref = repository ? `/review-logs?search=${encodeURIComponent(repository.fullName)}` : "/review-logs";
  const preparation = repository ? getPreparationProgress(repository.indexStatus, repository.analysisStatus) : null;
  const ready = repository?.readiness.status === "ready" && repository.autoReview;
  const steps = [
    { label: "Connect", done: connected || complete, description: "Authorize your Git provider so Octopus can access your repositories." },
    { label: "Confirm repository readiness", done: ready || complete, description: complete
      ? "This repository has successfully received a review. Manage its current settings from the repository page."
      : repository
      ? !repository.autoReview ? "Automatic reviews are off. Enable Auto Review in this repository when you are ready."
        : repository.readiness.message
      : connected ? "Sync your repositories in Integrations, then choose one below." : "Choose the repository for your first review after connecting." },
    { label: "Open a PR", done: latestReview !== null || complete, description: latestReview
      ? `Octopus received PR #${latestReview.number}. Follow its progress in Review Logs.`
      : "Open a non-draft pull request, or update an existing one. Connecting alone does not review PRs that were already open." },
    { label: "First review completed", done: complete, description: complete
      ? `PR #${completedReview.number} has a completed review. Open it to read the feedback.`
      : latestReview?.status === "failed" ? "The review failed. Check the PR and your connection or credits, then request a new review."
      : latestReview?.status === "pending" ? "Your review is waiting to start. Follow its progress in Review Logs."
      : latestReview?.status === "completed" ? "Open the PR to check the saved review. This guide completes after Octopus confirms successful publication."
      : latestReview ? "Your review is in progress. This step completes only when a review succeeds."
      : "Your first completed review will appear here." },
  ];

  return (
    <Card className="mt-6 gap-4 p-4 sm:p-6" aria-label="First review setup">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">{complete ? "Your first review is complete" : "Get your first review"}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{steps.filter(step => step.done).length}/4 steps completed</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Hide first review guide" onClick={() => {
          document.cookie = `onboarding_first_review_dismissed_${orgId}=1; path=/; max-age=31536000; samesite=lax`;
          setDismissed(true);
        }}><IconX className="size-4" /></Button>
      </div>
      {repositories.length > 0 && (
        <div className="grid gap-2">
          <label htmlFor="onboarding-repository" className="text-sm font-medium">Repository for your first review</label>
          <select id="onboarding-repository" value={repository?.id ?? ""}
            className="h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
            onChange={event => {
              const params = new URLSearchParams(searchParams.toString());
              params.set("onboardingRepo", event.target.value);
              router.replace(`/dashboard?${params}`, { scroll: false });
            }}>
            {repositories.map(repo => <option key={repo.id} value={repo.id}>{repo.fullName}</option>)}
          </select>
        </div>
      )}
      <ol className="grid gap-4 sm:grid-cols-2">
        {steps.map((step, index) => (
          <li key={step.label} className="flex min-w-0 gap-3">
            {step.done ? <IconCircleCheck className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
              : <IconCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <div className="min-w-0">
              <p className="text-sm font-medium">{index + 1}. {step.label}<span className="sr-only">{step.done ? " — complete" : " — not complete"}</span></p>
              <p className="mt-1 text-sm text-muted-foreground">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      {preparation && !complete && (
        <p role="status" className={`flex items-start gap-2 rounded-md border p-3 text-sm ${preparation.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
          {preparation.status === "working" && <IconLoader2 className="mt-0.5 size-4 shrink-0 animate-spin" aria-hidden="true" />}
          {preparation.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {!connected && <Button asChild><a href="/settings/integrations">Connect a provider</a></Button>}
        {connected && (!repository || !ready) && <Button asChild variant={complete ? "outline" : "default"}><a href={repository && !repository.autoReview ? repoHref : setupHref}>{repository && !repository.autoReview ? "Configure Auto Review" : "Check setup"}</a></Button>}
        {repository && (repository.autoReview || complete) && <Button asChild variant="outline"><a href={repoHref}>View repository</a></Button>}
        {repository?.url && !complete && <Button asChild variant={ready ? "default" : "outline"}><a href={repository.url} target="_blank" rel="noopener noreferrer">Open repository to create a PR</a></Button>}
        {completedReview && <Button asChild><a href={completedReview.url} target="_blank" rel="noopener noreferrer">Read your review on PR #{completedReview.number}</a></Button>}
        {latestReview && !complete && ["failed", "completed"].includes(latestReview.status) && <Button asChild variant="outline"><a href={latestReview.url} target="_blank" rel="noopener noreferrer">Open pull request</a></Button>}
        {(latestReview || complete) && <Button asChild variant="outline"><a href={reviewHref}>View review progress</a></Button>}
      </div>
    </Card>
  );
}
