import { mock } from "bun:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }), useSearchParams: () => new URLSearchParams() }));
mock.module("@/components/link", () => ({ default: (props: ComponentProps<"a">) => <a {...props} /> }));
mock.module("@/components/mermaid-diagram", () => ({ MermaidDiagram: () => null }));
mock.module("@/components/chat-provider", () => ({ useChat: () => ({ openWithRepoContext() {} }) }));
mock.module("@/lib/pubby-client", () => ({ getPubbyClient() {} }));
mock.module("@/app/(app)/actions", () => ({ indexRepository() {}, cancelIndexing() {}, syncRepos() {} }));
mock.module("@/app/(app)/repositories/actions", () => ({
  analyzeRepository() {}, cancelAnalysis() {}, toggleAutoReview() {}, toggleFavoriteRepository() {}, deletePullRequestReview() {},
  cancelPullRequestReview() {}, updateRepoModels() {}, transferRepository() {}, removeRepository() {}, restoreRepository() {}, getRepoDetail() {}, updateReviewConfig() {},
}));
const { RepositoriesContent } = await import("@/app/(app)/repositories/repositories-content");
const { IndexingLogs } = await import("@/components/indexing-logs");
const repo = {
  id: "repo", name: "project", fullName: "team/project", provider: "bitbucket", defaultBranch: "main", isActive: true,
  autoReview: true, dismissedAt: null, isNew: true, indexStatus: "pending", indexedAt: null, indexedFiles: 0,
  totalFiles: 0, totalChunks: 0, totalVectors: 0, indexDurationMs: null, contributorCount: 0, analysisStatus: "none",
  analyzedAt: null, reviewModelId: null, embedModelId: null, reviewConfig: {}, pullRequestCount: 0,
};
const render = (allowed = true) => renderToStaticMarkup(<RepositoriesContent
  repos={[repo]} orgId="org" selectedRepoId="repo" githubAppSlug={null} favoriteRepoIds={[]}
  canManageRepos={allowed} canConfigureReviews={allowed}
/>);
for (const status of ["pending", "indexing", "failed", "indexed", "stale"]) {
  repo.indexStatus = status;
  const html = render();
  const control = html.match(/<button[^>]+role="switch"[^>]*>/)?.[0];
  assert.ok(control, `missing switch for ${status}`);
  assert.ok(control.includes('aria-checked="true"'), `must show the persisted setting during ${status}`);
  assert.ok(!/ disabled(?:=|\s|>)/.test(control), `must allow turning off during ${status}`);
  assert.ok(!html.includes("Index and analyze this repository first"));
}
repo.autoReview = false;
assert.match(render(), /role="switch"[^>]*aria-checked="false"/);
assert.ok(render().includes("Automatic reviews are off"));
assert.match(render(false), /<button[^>]+role="switch"[^>]* disabled=/);
assert.ok(render(false).includes("An owner or admin can change automatic reviews"));
for (const [provider, label, target] of [
  ["github", "Check GitHub access", "/api/github/install?"],
  ["bitbucket", "Check Bitbucket connection", "/settings/integrations#bitbucket"],
  ["gitlab", "Check GitLab connection", "/settings/integrations#gitlab"],
  ["forgejo", "Check Forgejo connection", "/settings/integrations#forgejo"],
]) {
  const html = renderToStaticMarkup(<IndexingLogs repoId="repo" orgId="org" provider={provider} initialStatus="failed" />);
  assert.ok(html.includes(label));
  assert.ok(html.includes(target));
  if (provider !== "github") assert.ok(!html.includes("/api/github/install"));
}
console.log("Rendered saved Auto Review states, permissions and four provider recovery links passed");
