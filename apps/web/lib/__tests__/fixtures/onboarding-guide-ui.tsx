import * as React from "react";
import { createRoot } from "react-dom/client";
import { OnboardingTips, type OnboardingRepository } from "../../../components/dashboard/onboarding-tips";

const listeners = new Map<string, Set<() => void>>();
const repositories: OnboardingRepository[] = ["first", "second"].map(id => ({
  id, fullName: `team/${id}`, provider: "github", autoReview: true, indexStatus: "pending", analysisStatus: "none",
  url: `https://github.com/team/${id}`, readiness: { status: "ready", message: "Repository access confirmed. Open a PR to confirm delivery." },
}));
const fixture = {
  repositories, orgId: "fixture-org", selected: "first", refreshes: 0,
  latestReview: null as { id: string; number: number; status: string; url: string } | null,
  completedReview: null as { id: string; number: number; url: string } | null,
  channel: {
    bind(event: string, fn: () => void) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(fn); },
    unbind(event: string, fn: () => void) { listeners.get(event)?.delete(fn); },
  },
  router: {
    refresh() { fixture.refreshes++; render(); },
    replace(url: string) { history.replaceState(null, "", url); fixture.selected = new URL(url, location.origin).searchParams.get("onboardingRepo")!; render(); },
  },
  emit(event: string) { for (const fn of listeners.get(event) ?? []) fn(); },
};
Object.assign(window, { onboardingFixture: fixture });
const root = createRoot(document.getElementById("root")!);
function render() {
  root.render(<main className="mx-auto max-w-4xl p-4 sm:p-10"><h1 className="text-2xl font-semibold">Dashboard</h1><OnboardingTips
    key={fixture.orgId} orgId={fixture.orgId} connected repositories={repositories} repository={{ ...repositories.find(repo => repo.id === fixture.selected)! }}
    latestReview={fixture.latestReview} completedReview={fixture.completedReview}
  /></main>);
}
render();
