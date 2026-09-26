import { mock } from "bun:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

const setup = { sync: { status: "ready" }, webhook: { status: "ready" } };
const repo = (id: string, age: number) => ({
  id, name: id, fullName: `team/${id}`, provider: "github", installationId: 42, webhookSetupStatus: null,
  createdAt: new Date(age), defaultBranch: "main", isActive: true, indexStatus: "pending", indexedAt: null,
  indexedFiles: 0, totalFiles: 0, totalChunks: 0, totalVectors: 0, indexDurationMs: null,
  summary: null, purpose: null, analysisStatus: "none", autoReview: true, pullRequests: [],
});
let repositories = [repo("new", 2000), repo("first", 1000)];
type Review = { id: string; repositoryId: string; number: number; status: string; url: string; firstReviewCompletedAt: Date | null };
let reviews: Review[] = [];
let dismissed = false;
let installed: number | null = 42;
let bitbucket: { workspaceName: string; setupStatus: typeof setup } | null = null;
let forgejo: { username: string; forgejoHost: string; setupStatus: typeof setup } | null = null;
const calls: Array<{ where: Record<string, unknown> }> = [];
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: (name: string) =>
  name === "current_org_id" ? { value: "org" } : name === "onboarding_dismissed" || (dismissed && name === "onboarding_first_review_dismissed_org") ? { value: "1" } : undefined }) }));
mock.module("next/navigation", () => ({ redirect: (path: string) => { throw new Error(path); }, useRouter: () => ({ refresh() {} }), useSearchParams: () => new URLSearchParams() }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user" } }) } } }));
mock.module("@/lib/github-app-config", () => ({ getGithubAppConfig: async () => ({ slug: "octopus" }) }));
mock.module("@/lib/stripe", () => ({ getCustomerPaymentMethods: async () => [] }));
mock.module("@/lib/crypto", () => ({ decryptStringMaybeLegacy: (value: string) => value }));
mock.module("@/lib/pubby-client", () => ({ getPubbyClient() {} }));
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async (args: { where: { organizationId: string; organization: unknown } }) => {
    assert.equal(args.where.organizationId, "org");
    assert.deepEqual(args.where.organization, { deletedAt: null, bannedAt: null });
    return { role: "owner", scopes: [], organization: { id: "org", githubInstallationId: installed, githubSetupStatus: setup, stripeCustomerId: null, repositories } };
  } },
  bitbucketIntegration: { findUnique: async () => bitbucket }, gitlabIntegration: { findUnique: async () => null },
  forgejoIntegration: { findUnique: async () => forgejo }, linearIntegration: { findUnique: async () => null }, jiraIntegration: { findUnique: async () => null },
  reviewIssue: { findMany: async () => [] },
  pullRequest: { findMany: async () => [], findFirst: async (args: { where: { repository: { organizationId: string }; repositoryId?: string; firstReviewCompletedAt?: { not: null } } }) => {
    calls.push(args);
    assert.equal(args.where.repository.organizationId, "org", "review evidence must remain org scoped");
    return reviews.find(row => (!args.where.repositoryId || row.repositoryId === args.where.repositoryId) && (!args.where.firstReviewCompletedAt || row.firstReviewCompletedAt !== null)) ?? null;
  } },
} }));
// Unrelated analytics stay outside this onboarding behavior check.
for (const [file, name] of Object.entries({
  "time-to-merge": "TimeToMergeCard", "issues-by-severity": "IssuesBySeverityCard", "comments-per-pr": "CommentsPerPrCard",
  "prs-per-developer": "PrsPerDeveloperCard", "recent-issues": "RecentIssuesCard", "weekly-summary": "WeeklySummaryCard",
  "repo-table": "RepoTable", "kpi-filters": "KpiFilters", "providers-banner": "ProvidersBanner", "buy-credits-button": "BuyCreditsButton",
})) mock.module(`@/components/dashboard/${file}`, () => ({ [name]: () => null }));
mock.module("@/components/sync-repos-button", () => ({ SyncReposButton: () => null }));
const { default: DashboardPage } = await import("@/app/(app)/dashboard/page");
async function render(onboardingRepo?: string) {
  return renderToStaticMarkup(await DashboardPage({ searchParams: Promise.resolve({ onboardingRepo }) }));
}
let html = await render();
assert.ok(html.includes('value="first" selected=""'), "default repository remains stable when a newer repository is updated");
assert.ok(html.includes("2/4 steps completed"));
assert.ok(html.includes("without preparing an index manually"));
assert.ok(!html.includes("Your first review is complete"));
// Prepared flags across several repositories are not review completion evidence.
repositories[0].indexStatus = "indexed";
repositories[1].analysisStatus = "analyzed";
assert.ok(!(await render()).includes("Your first review is complete"));
reviews = [{ id: "pr", repositoryId: "new", number: 7, status: "completed", url: "https://github.com/team/new/pull/7", firstReviewCompletedAt: null }];
assert.ok(!(await render("new")).includes("4/4 steps completed"), "saving a report before publication is not completion");
reviews[0].firstReviewCompletedAt = new Date();
assert.ok((await render()).includes("4/4 steps completed"));
reviews[0].status = "failed";
assert.ok((await render()).includes("4/4 steps completed"), "a later failed retry does not erase the first success");
html = await render("first");
assert.ok(html.includes("2/4 steps completed"), "a different repository's review cannot complete the selected repository's guide");
assert.ok(!html.includes("Read your review on PR #7"));
assert.ok((await render("foreign-repo")).includes('value="new" selected=""'), "foreign repository selection falls back inside this org");
reviews = [{ ...reviews[0], repositoryId: "first", status: "failed", firstReviewCompletedAt: null }];
html = await render("first");
assert.ok(html.includes("3/4 steps completed"));
assert.ok(html.includes("The review failed"));
assert.ok(!html.includes("Your review is in progress"));
installed = null;
assert.ok((await render("first")).includes("Reconnect this repository"));
dismissed = true;
assert.ok(!(await render()).includes('aria-label="First review setup"'));
assert.ok(calls.some(call => call.where.repositoryId === "first" && call.where.firstReviewCompletedAt));
dismissed = false;
reviews = [];
for (const [provider, installation] of [["bitbucket", null], ["bitbucket", 77], ["forgejo", null]] as const) {
  installed = installation;
  bitbucket = provider === "bitbucket" ? { workspaceName: "team", setupStatus: setup } : null;
  forgejo = provider === "forgejo" ? { username: "team", forgejoHost: "https://forge.example", setupStatus: setup } : null;
  repositories = [repo("old-github", 1000), { ...repo("connected", 2000), provider }];
  assert.ok((await render()).includes('value="connected" selected=""'), `${provider} must take priority over disconnected or mismatched GitHub`);
  assert.ok((await render("old-github")).includes('value="old-github" selected=""'), "explicit same-org selection wins");
  assert.ok((await render("foreign-repo")).includes('value="connected" selected=""'), "invalid selection uses the connected default");
  reviews = [{ id: "receipt", repositoryId: "old-github", number: 8, status: "failed", url: "https://github.com/team/old-github/pull/8", firstReviewCompletedAt: new Date() }];
  assert.ok((await render()).includes('value="old-github" selected=""'), "historical completion receipt wins over connection eligibility");
  assert.ok((await render("connected")).includes('value="connected" selected=""'), "explicit selection wins over historical receipt");
  reviews = [];
}
forgejo = null;
bitbucket = { workspaceName: "team", setupStatus: setup };
installed = 42;
repositories = [repo("new-github", 3000), { ...repo("b-connected", 2000), provider: "bitbucket" }, repo("a-connected", 2000)];
assert.ok((await render()).includes('value="a-connected" selected=""'), "oldest eligible repository ties are broken by id");
repositories.reverse();
assert.ok((await render()).includes('value="a-connected" selected=""'), "query update order does not affect the default");
installed = null;
bitbucket = null;
repositories = [repo("b-old", 1000), repo("newest", 2000), repo("a-old", 1000)];
assert.ok((await render()).includes('value="a-old" selected=""'), "oldest-any reconnect fallback also has a deterministic tie break");
repositories = [];
assert.ok((await render()).includes('aria-label="First review setup"'), "empty organizations retain the connection guide");
console.log("Dashboard selection, provider readiness, automatic preparation and actual completion evidence passed");
