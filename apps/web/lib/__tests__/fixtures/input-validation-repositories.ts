import assert from "node:assert/strict";
import { mock } from "bun:test";
let signedIn = true;
let role = "owner";
let selectedOrg = "org_1";
let reads = 0;
let effects = 0;
const writes: Record<string, unknown>[] = [];
const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>) => { try { await run(); } catch (error) { failures.push(`${name}: ${error}`); } };
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: selectedOrg }) }) }));
mock.module("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user: { id: "user_1" } } : null } } }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: () => { effects++; } } }));
mock.module("@/lib/events/bus", () => ({ eventBus: { emit: () => { effects++; } } }));
mock.module("@/lib/analysis-abort", () => ({ createAnalysisAbortController: () => { effects++; return new AbortController(); }, abortAnalysis: () => { effects++; }, clearAnalysisAbortController: () => {} }));
mock.module("@/lib/indexing-abort", () => ({ abortIndexing: () => { effects++; } }));
mock.module("@/lib/repo-sync", () => ({ syncForgejoRepos: async () => { effects++; } }));
mock.module("@/lib/qdrant", () => ({ deleteReviewChunksByPR: async () => { effects++; }, deleteDiagramChunksByPR: async () => { effects++; } }));
mock.module("@octopus/db", () => ({ prisma: {
  repository: {
    findUnique: async ({ where, select }: { where: { id: string }; select: { organization: { select: { members: { where: { userId: string; deletedAt: null } } } } } }) => {
      reads++; assert.equal(typeof where.id, "string");
      assert.equal(select.organization.select.members.where.userId, "user_1"); assert.equal(select.organization.select.members.where.deletedAt, null);
      return where.id === "repo_1" ? { id: "repo_1", organizationId: "org_1", provider: "github", contributors: [], pullRequests: [], reviewConfig: {}, indexStatus: "pending", analysisStatus: "none", dismissedAt: new Date(), organization: { members: role === "outsider" ? [] : [{ role, scopes: [] }] } } : null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => { assert.equal(where.id, "repo_1"); writes.push(data); },
    findMany: async ({ where, skip, take }: { where: { organizationId: string; fullName?: { contains: string } }; skip: number; take: number }) => {
      reads++; assert.equal(where.organizationId, "org_1"); assert.equal(Number.isInteger(skip), true); assert.equal(Number.isInteger(take), true);
      if (where.fullName) assert.equal(typeof where.fullName.contains, "string");
      return [{ id: "repo_1", name: "repo", fullName: "org/repo", reviewModelId: null, embedModelId: null }];
    },
    count: async ({ where }: { where: { organizationId: string } }) => { reads++; assert.equal(where.organizationId, "org_1"); return 1; },
  },
  organizationMember: { findFirst: async ({ where }: { where: { userId: string; organizationId?: string; deletedAt: null } }) => {
    assert.equal(where.userId, "user_1"); assert.equal(where.deletedAt, null);
    return role !== "outsider" && (!where.organizationId || where.organizationId === "org_1") ? { organizationId: "org_1", role, scopes: [], organization: { name: "Org" } } : null;
  } },
  pullRequest: { findUnique: async ({ where }: { where: { id: string } }) => { reads++; assert.equal(typeof where.id, "string"); return null; } },
  favoriteRepository: { findUnique: async () => null, create: async () => { effects++; } },
} }));
const a = await import("@/app/(app)/repositories/actions");
const { searchRepoModels } = await import("@/app/(app)/settings/models/actions");
const mutations = [a.analyzeRepository, a.cancelAnalysis, a.toggleFavoriteRepository, a.deletePullRequestReview, a.cancelPullRequestReview, a.removeRepository, a.restoreRepository,
  (id: string) => a.updateRepoModels(id, null, null), (id: string) => a.transferRepository(id, "org_1"),
  (id: string) => a.toggleAutoReview(id, false), (id: string) => a.updateReviewConfig(id, {}),
  (id: string) => a.updateRepoConfigSettings(id, { useRepoConfig: false, repoConfigFiles: ["AGENTS.md"] })];
for (const invalid of [null, {}, [], "", "nul\0value", "bad\ud800", "x".repeat(1025)]) {
  for (const action of mutations) await check("invalid repository/PR ID", async () => {
    reads = 0; writes.length = 0; effects = 0;
    assert.ok((await action(invalid as string)).error); assert.equal(reads, 0); assert.equal(writes.length, 0); assert.equal(effects, 0);
  });
  for (const action of [a.getRepoDetail, a.getReviewConfig]) await check("invalid repository read", async () => { reads = 0; assert.equal(await action(invalid as string), null); assert.equal(reads, 0); });
}
const badUpdates = [
  () => a.updateRepoModels("repo_1", {} as string, null), () => a.updateRepoModels("repo_1", null, "bad\0model"),
  () => a.transferRepository("repo_1", {} as string), () => a.toggleAutoReview("repo_1", "false" as unknown as boolean),
  ...[null, [], {}, { useRepoConfig: "false", repoConfigFiles: [] }, { useRepoConfig: false, repoConfigFiles: [null] }].map(input => () => a.updateRepoConfigSettings("repo_1", input as Parameters<typeof a.updateRepoConfigSettings>[1])),
  ...[null, [], new Date(), new Map(), { maxFindings: "3" }, { maxFindings: 1.5 }, { maxFindings: NaN }, { maxFindings: 51 }, { inlineThreshold: null }, { enableConflictDetection: "false" }, { enableTwoPassReview: {} }, { disabledCategories: [null] }, { disabledCategories: ["bad\0text"] }, { confidenceThreshold: Infinity }, { unexpected: true }].map(config => () => a.updateReviewConfig("repo_1", config as Parameters<typeof a.updateReviewConfig>[1])),
];
for (const update of badUpdates) await check("invalid setting payload", async () => { writes.length = 0; effects = 0; assert.ok((await update()).error); assert.equal(writes.length, 0); assert.equal(effects, 0); });
const settings = [() => a.updateRepoModels("repo_1", null, null), () => a.toggleAutoReview("repo_1", false), () => a.updateReviewConfig("repo_1", { inlineThreshold: "low" }), () => a.updateRepoConfigSettings("repo_1", { useRepoConfig: false, repoConfigFiles: ["CUSTOM.md"] }), () => a.removeRepository("repo_1"), () => a.restoreRepository("repo_1")];
for (const deniedRole of ["member", "outsider"]) {
  role = deniedRole;
  for (const update of settings) await check(`${deniedRole} settings`, async () => { writes.length = 0; effects = 0; assert.ok((await update()).error); assert.equal(writes.length, 0); assert.equal(effects, 0); });
}
role = "owner"; signedIn = false;
for (const update of settings) await check("signed out settings", async () => { writes.length = 0; await assert.rejects(update, /redirect:\/login/); assert.equal(writes.length, 0); });
signedIn = true;
for (const [query, skip, take] of [[{}, 0, 10], [null, 0, 10], ["bad\0query", 0, 10], ["", -1, 10], ["", 0.5, 10], ["", 2 ** 31, 10], ["", 0, {}], ["", 0, 0], ["", 0, 101], ["", 0, NaN]] as const) await check("invalid search arguments", async () => {
  reads = 0; assert.deepEqual(await searchRepoModels(query as string, skip, take as number), { repos: [], total: 0 }); assert.equal(reads, 0);
});
selectedOrg = "other_org";
await check("search organization scoping", async () => { reads = 0; assert.deepEqual(await searchRepoModels("", 0, 10), { repos: [], total: 0 }); assert.equal(reads, 0); });
selectedOrg = "org_1";
await check("valid settings and searches", async () => {
  assert.equal((await a.updateRepoModels("repo_1", null, null)).success, true);
  assert.deepEqual(writes.at(-1), { reviewModelId: null, embedModelId: null });
  assert.equal((await a.updateReviewConfig("repo_1", { maxFindings: 30, inlineThreshold: "low", enableConflictDetection: false, disabledCategories: [], confidenceThreshold: "MEDIUM", enableTwoPassReview: false })).success, true);
  assert.equal((await a.updateRepoConfigSettings("repo_1", { useRepoConfig: false, repoConfigFiles: ["CUSTOM.md"] })).success, true);
  assert.deepEqual(writes.at(-1), { useRepoConfig: false, repoConfigFiles: ["CUSTOM.md"] });
  assert.equal((await a.toggleAutoReview("repo_1", false)).error, undefined);
  assert.deepEqual(writes.at(-1), { autoReview: false });
  assert.equal((await searchRepoModels("", 0, 10)).total, 1);
  assert.equal((await searchRepoModels("repo", 10, 10)).repos[0]?.id, "repo_1");
});
assert.deepEqual(failures, []);
console.log("input validation checks passed");
