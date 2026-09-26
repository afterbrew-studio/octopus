import { beforeEach, describe, expect, it, mock } from "bun:test";

mock.module("server-only", () => ({}));

// Prisma-shaped arguments captured by the test doubles below; shape is asserted per test.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

// ── fixtures (reset in beforeEach) ──
type ExistingRow = { externalId: string; dismissedAt: Date | null; webhookSetupStatus?: unknown };
let orgRow: { githubInstallationId: number | null } | null = { githubInstallationId: 111 };
let repoInstallations: Array<{ installationId: number | null }> = [];
let existingRows: Record<string, ExistingRow[]> = { github: [], bitbucket: [], gitlab: [] };
let bitbucket: { id?: string; workspaceSlug: string; webhookSecret?: string; webhookUuid?: string } | null = null;
let gitlab: { id?: string; gitlabHost?: string; namespacePath: string; webhookSecret: string | null } | null = null;
let forgejo: { id: string; forgejoHost: string; accessTokenEnc: string; connectorError?: string; organization?: { bannedAt: Date | null; deletedAt: Date | null } } | null = null;
let afterForgejoListing: () => void = () => {};
let forgejoRepos: Array<Loose> = [];
let forgejoListingError: Error | null = null;
let forgejoDisconnectDuringListing = false;
let updateManyCount = 0;
const upserts: Array<Loose> = [];
const updateManys: Array<Loose> = [];
const setupUpdates: Array<Loose> = [];
const persistSetup = mock(async (args: Loose) => { setupUpdates.push(args); return { count: 1 }; });

const transaction = mock(async (callback: (tx: unknown) => Promise<unknown>): Promise<unknown> => callback(prisma));
const prisma = {
  $transaction: transaction,
  $queryRaw: mock(async () => [{ acquired: true }]),
  organization: { findUnique: mock(async () => orgRow), updateMany: persistSetup },
  repository: {
    findMany: mock(async (args: Loose) =>
      args.distinct ? repoInstallations : (existingRows[args.where.provider] ?? []),
    ),
    upsert: mock(async (args: Loose) => {
      upserts.push(args);
      return {
        id: `row_${args.where.provider_externalId_organizationId.externalId}`,
        fullName: args.create.fullName,
      };
    }),
    updateMany: mock(async (args: Loose) => {
      updateManys.push(args);
      return { count: updateManyCount };
    }),
    findUnique: mock(async (args: Loose) => {
      const ext = args.where.provider_externalId_organizationId.externalId;
      const row = existingRows.github.find((r) => r.externalId === ext);
      return row ? { dismissedAt: row.dismissedAt } : null;
    }),
  },
  bitbucketIntegration: { findUnique: mock(async () => bitbucket), update: persistSetup, updateMany: persistSetup },
  gitlabIntegration: { findUnique: mock(async () => gitlab), update: persistSetup, updateMany: persistSetup },
  forgejoIntegration: { findUnique: mock(async () => forgejo ? { ...forgejo, organization: forgejo.organization ?? { bannedAt: null, deletedAt: null } } : null), update: persistSetup, updateMany: persistSetup },
};
mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma }));

class GithubRateLimitError extends Error {
  constructor(readonly status = 429, readonly retryAfterSeconds: number | null = null) {
    super(`GitHub rate limited (${status})`);
    this.name = "GithubRateLimitError";
  }
}
let ghRepos: Record<number, Array<Loose> | Error> = {};
const listInstallationRepos = mock(async (installationId: number) => {
  const v = ghRepos[installationId];
  if (v instanceof Error) throw v;
  return v ?? [];
});
// bun's mock.module is process-wide: spread the real module so other test files
// that import un-mocked exports keep working, override only what we stub.
const actualGithub = await import("@/lib/github");
mock.module("@/lib/github", () => ({ ...actualGithub, listInstallationRepos, GithubRateLimitError }));

let bbRepos: Array<Loose> = [];
let bbListingError: Error | null = null;
let bbHookError: Error | null = null;
let glHookError: Error | null = null;
let glFailedProjects = new Set<string>();
let afterBitbucketListing = () => {};
let afterGitlabListing = () => {};
const createWebhook = mock(async () => { if (bbHookError) throw bbHookError; return "{octopus-hook}"; });
const actualBitbucket = await import("@/lib/bitbucket");
mock.module("@/lib/bitbucket", () => ({ ...actualBitbucket, listWorkspaceRepos: mock(async () => { if (bbListingError) throw bbListingError; afterBitbucketListing(); return bbRepos; }), createWebhook }));

let glProjects: Array<Loose> = [];
const createProjectWebhook = mock(async (_org: string, path: string) => { if (glHookError || glFailedProjects.has(path)) throw glHookError || new Error("private provider error"); return 1; });
const actualGitlab = await import("@/lib/gitlab");
mock.module("@/lib/gitlab", () => ({
  ...actualGitlab,
  listNamespaceProjects: mock(async () => { afterGitlabListing(); return glProjects; }),
  createProjectWebhook,
}));

const actualForgejo = await import("@/lib/forgejo");
mock.module("@/lib/forgejo", () => ({
  ...actualForgejo,
  listUserRepos: mock(async () => {
    if (forgejoListingError) throw forgejoListingError;
    if (forgejoDisconnectDuringListing) forgejo = null;
    afterForgejoListing();
    return forgejoRepos;
  }),
}));

const grantDeferredWelcomeCredit = mock(async () => {});
const actualOrgCreate = await import("@/lib/org-create");
mock.module("@/lib/org-create", () => ({ ...actualOrgCreate, grantDeferredWelcomeCredit }));

const trigger = mock(async () => {});
const actualPubby = await import("@/lib/pubby");
mock.module("@/lib/pubby", () => ({ ...actualPubby, pubby: { trigger }, PUBBY_ENABLED: true }));

const writeAuditLog = mock(async () => {});
const actualAudit = await import("@/lib/audit");
mock.module("@/lib/audit", () => ({ ...actualAudit, writeAuditLog }));

const enqueuePendingRepositoryIndexes = mock(async () => {});
mock.module("@/lib/repository-index-job", () => ({ enqueuePendingRepositoryIndexes }));

const { syncOrgRepos, applyRepositoryEvent } = await import("@/lib/repo-sync");

const gh = (id: number, name: string) => ({
  id,
  name,
  full_name: `acme/${name}`,
  private: true,
  default_branch: "main",
  html_url: `https://github.com/acme/${name}`,
});

describe("syncOrgRepos", () => {
  beforeEach(() => {
    orgRow = { githubInstallationId: 111 };
    repoInstallations = [];
    existingRows = { github: [], bitbucket: [], gitlab: [] };
    bitbucket = null;
    gitlab = null;
    forgejo = null;
    forgejoRepos = [];
    forgejoListingError = null;
    forgejoDisconnectDuringListing = false;
    afterForgejoListing = () => {};
    ghRepos = {};
    bbRepos = [];
    glProjects = [];
    updateManyCount = 0;
    upserts.length = 0;
    updateManys.length = 0;
    setupUpdates.length = 0;
    bbListingError = bbHookError = glHookError = null;
    glFailedProjects = new Set();
    afterBitbucketListing = afterGitlabListing = () => {};
    createWebhook.mockClear();
    listInstallationRepos.mockClear();
    createProjectWebhook.mockClear();
    grantDeferredWelcomeCredit.mockClear();
    trigger.mockClear();
    writeAuditLog.mockClear();
    enqueuePendingRepositoryIndexes.mockClear();
  });

  it("reports brand-new repositories as created and refreshed ones as synced only", async () => {
    existingRows.github = [{ externalId: "1", dismissedAt: null }];
    ghRepos[111] = [gh(1, "old"), gh(2, "new")];
    const r = await syncOrgRepos("org_1", { source: "scheduled" });
    expect(r.providers).toEqual(["github"]);
    expect(r.synced).toBe(2);
    expect(r.created).toBe(1);
    expect(r.createdRepos).toEqual([{ id: "row_2", fullName: "acme/new", provider: "github" }]);
    expect(upserts).toHaveLength(2);
    expect(upserts[1].create).toMatchObject({ externalId: "2", installationId: 111, isActive: true, organizationId: "org_1" });
    expect(grantDeferredWelcomeCredit).toHaveBeenCalledWith("org_1");
    expect(enqueuePendingRepositoryIndexes).toHaveBeenCalledWith("org_1", undefined, ["github"]);
  });

  it("scopes Forgejo identities by host, respects dismissal and admin access, and grants no welcome credit", async () => {
    orgRow = { githubInstallationId: null };
    forgejo = { id: "forge_1", forgejoHost: "https://forge.example.com", accessTokenEnc: "encrypted" };
    existingRows.forgejo = [{ externalId: "https://forge.example.com:2", dismissedAt: new Date() }];
    forgejoRepos = [
      { ...gh(1, "active"), permissions: { admin: true } },
      { ...gh(2, "dismissed"), permissions: { admin: true } },
      { ...gh(3, "reader"), permissions: { admin: false } },
      { ...gh(4, "archived"), permissions: { admin: true }, archived: true },
    ];
    const result = await syncOrgRepos("org_1", { source: "manual" });
    expect(result.providers).toEqual(["forgejo"]);
    expect(result.synced).toBe(1);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create).toMatchObject({ provider: "forgejo", externalId: "https://forge.example.com:1", organizationId: "org_1" });
    expect(updateManys[0].where).toMatchObject({ provider: "forgejo", externalId: { notIn: ["https://forge.example.com:1", "https://forge.example.com:2"] } });
    expect(grantDeferredWelcomeCredit).not.toHaveBeenCalled();
  });

  it("leaves Forgejo rows untouched on listing failure or a concurrent disconnect", async () => {
    orgRow = { githubInstallationId: null };
    forgejo = { id: "forge_1", forgejoHost: "https://forge.example.com", accessTokenEnc: "encrypted" };
    forgejoListingError = new Error("instance unavailable");
    await syncOrgRepos("org_1", { source: "manual" });
    expect(upserts).toHaveLength(0);
    expect(updateManys).toHaveLength(0);
    forgejoListingError = null;
    forgejoDisconnectDuringListing = true;
    forgejoRepos = [{ ...gh(1, "active"), permissions: { admin: true } }];
    await syncOrgRepos("org_1", { source: "manual" });
    expect(upserts).toHaveLength(0);
    expect(updateManys).toHaveLength(0);
  });

  it("does not activate Forgejo repositories when the connector pauses or organization closes during discovery", async () => {
    orgRow = { githubInstallationId: null };
    forgejoRepos = [{ ...gh(1, "active"), permissions: { admin: true } }];
    for (const state of ["paused", "banned", "deleted"] as const) {
      forgejo = { id: "forge_1", forgejoHost: "https://forge.example.com", accessTokenEnc: "encrypted" };
      afterForgejoListing = () => {
        if (state === "paused") forgejo = { ...forgejo!, connectorError: "Write result unknown" };
        else forgejo = { ...forgejo!, organization: { bannedAt: state === "banned" ? new Date() : null, deletedAt: state === "deleted" ? new Date() : null } };
      };
      const result = await syncOrgRepos("org_1", { source: "manual" });
      expect(result.providers).toEqual([]);
      expect(upserts).toHaveLength(0);
      expect(updateManys).toHaveLength(0);
    }
  });

  it("never resurrects a repository the user removed, and never deactivates dismissed rows", async () => {
    existingRows.github = [{ externalId: "9", dismissedAt: new Date("2026-08-01T00:00:00Z") }];
    ghRepos[111] = [gh(9, "removed-by-user"), gh(10, "fresh")];
    const r = await syncOrgRepos("org_1", { source: "manual" });
    expect(upserts.map((u) => u.where.provider_externalId_organizationId.externalId)).toEqual(["10"]);
    expect(r.created).toBe(1);
    const deactivation = updateManys.find((u) => u.where.provider === "github");
    expect(deactivation?.where).toMatchObject({
      organizationId: "org_1",
      isActive: true,
      dismissedAt: null,
      externalId: { notIn: ["9", "10"] },
      OR: [{ installationId: null }, { installationId: { in: [111] } }],
    });
    expect(deactivation?.data).toEqual({ isActive: false });
  });

  it("reports deactivated rows and never deactivates repos of installations it did not list", async () => {
    updateManyCount = 3;
    ghRepos[111] = [gh(1, "a")];
    const r = await syncOrgRepos("org_1", { source: "scheduled" });
    expect(r.removed).toBe(3);
    const deactivation = updateManys.find((u) => u.where.provider === "github");
    // Scheduled runs list only the org-level installation, so legacy rows on
    // other installations are excluded from the notIn sweep by this clause.
    expect(deactivation?.where.OR).toEqual([{ installationId: null }, { installationId: { in: [111] } }]);
  });

  it("keeps syncing other providers when a manual Sync hits a GitHub rate limit", async () => {
    ghRepos[111] = new GithubRateLimitError(429, 60);
    bitbucket = { workspaceSlug: "acme" };
    bbRepos = [{ uuid: "{u9}", name: "svc", full_name: "acme/svc", mainbranch: { name: "main" } }];
    const r = await syncOrgRepos("org_1", { source: "manual" });
    expect(r.providers).toEqual(["github", "bitbucket"]);
    expect(r.created).toBe(1);
    expect(updateManys.filter((u) => u.where.provider === "github")).toHaveLength(0);
  });

  it("uses only the org-level installation when scheduled, and widens to repo-level ids for manual sync", async () => {
    repoInstallations = [{ installationId: 222 }];
    ghRepos[111] = [];
    ghRepos[222] = [];
    await syncOrgRepos("org_1", { source: "scheduled" });
    expect(listInstallationRepos.mock.calls.map((c) => c[0])).toEqual([111]);
    listInstallationRepos.mockClear();
    await syncOrgRepos("org_1", { source: "manual" });
    expect(listInstallationRepos.mock.calls.map((c) => c[0]).sort()).toEqual([111, 222]);
  });

  it("propagates a GitHub rate limit so the sweep can stop", async () => {
    ghRepos[111] = new GithubRateLimitError(403, 60);
    await expect(syncOrgRepos("org_1", { source: "scheduled" })).rejects.toBeInstanceOf(GithubRateLimitError);
  });

  it("reports an ordinary listing failure, keeps syncing other installations, and skips deactivation", async () => {
    repoInstallations = [{ installationId: 222 }];
    ghRepos[111] = new Error("boom");
    ghRepos[222] = [gh(5, "still-listed")];
    const r = await syncOrgRepos("org_1", { source: "manual" });
    expect(r.created).toBe(1);
    expect(r.error).toContain("GitHub repository sync failed");
    expect(setupUpdates.at(-1)?.data.githubSetupStatus.sync.status).toBe("failed");
    expect(updateManys.filter((u) => u.where.provider === "github")).toHaveLength(0);
  });

  it("reconciles GitLab hooks for existing and new projects and persists project readiness", async () => {
    orgRow = { githubInstallationId: null };
    gitlab = { namespacePath: "acme", webhookSecret: "s3cret" };
    existingRows.gitlab = [{ externalId: "1", dismissedAt: null }];
    glProjects = [
      { id: 1, name: "known", path_with_namespace: "acme/known", default_branch: "main" },
      { id: 2, name: "brand-new", path_with_namespace: "acme/brand-new", default_branch: null },
    ];
    const r = await syncOrgRepos("org_1", { source: "scheduled" });
    expect(r.providers).toEqual(["gitlab"]);
    expect(r.created).toBe(1);
    expect(createProjectWebhook).toHaveBeenCalledTimes(2);
    expect(createProjectWebhook.mock.calls[0][1]).toBe("acme/known");
    expect(updateManys.filter(u => u.data.webhookSetupStatus).map(u => u.data.webhookSetupStatus.status)).toEqual(["ready", "ready"]);
    expect(upserts[1].create.defaultBranch).toBe("main");

    createProjectWebhook.mockClear();
    upserts.length = 0;
    existingRows.gitlab = [];
    gitlab = { namespacePath: "acme", webhookSecret: null };
    await syncOrgRepos("org_1", { source: "scheduled" });
    expect(createProjectWebhook).not.toHaveBeenCalled();
    expect(setupUpdates.at(-1)?.data.setupStatus.webhook.status).toBe("failed");
  });

  it("syncs Bitbucket repositories from the workspace", async () => {
    orgRow = { githubInstallationId: null };
    bitbucket = { id: "bb1", workspaceSlug: "acme", webhookSecret: "fixture-secret" };
    bbRepos = [{ uuid: "{u1}", name: "svc", full_name: "acme/svc", mainbranch: { name: "develop" } }];
    const r = await syncOrgRepos("org_1", { source: "scheduled" });
    expect(r.providers).toEqual(["bitbucket"]);
    expect(upserts[0].create).toMatchObject({ externalId: "{u1}", defaultBranch: "develop", provider: "bitbucket" });
    expect(setupUpdates.at(-1)?.data).toMatchObject({ webhookUuid: "{octopus-hook}", setupStatus: { sync: { status: "ready" }, webhook: { status: "ready" } } });
  });

  it("keeps authorization separate from a failed webhook and repairs on retry", async () => {
    bitbucket = { id: "bb1", workspaceSlug: "acme", webhookSecret: "fixture-secret" };
    bbRepos = [{ uuid: "1", name: "repo", full_name: "acme/repo" }];
    bbHookError = new Error("raw private provider detail");
    const failed = await syncOrgRepos("org_1", { source: "manual", providers: ["bitbucket"] });
    expect(failed.providers).toEqual(["bitbucket"]);
    expect(failed.error).toContain("Could not check Bitbucket webhook setup");
    expect(failed.error).not.toContain("raw private");
    expect(setupUpdates.at(-1)?.data.setupStatus).toMatchObject({ sync: { status: "ready" }, webhook: { status: "failed" } });
    expect(listInstallationRepos).not.toHaveBeenCalled();
    bbHookError = null;
    const repaired = await syncOrgRepos("org_1", { source: "manual", providers: ["bitbucket"] });
    expect(repaired.error).toBeUndefined();
    expect(setupUpdates.at(-1)?.data.setupStatus.webhook.status).toBe("ready");
  });

  it("persists provider listing failures without deactivating repositories", async () => {
    bitbucket = { id: "bb1", workspaceSlug: "acme", webhookSecret: "fixture-secret" };
    bbListingError = new Error("credential-bearing response");
    const result = await syncOrgRepos("org_1", { source: "manual", providers: ["bitbucket"] });
    expect(result.error).toContain("Bitbucket repository sync failed");
    expect(setupUpdates.at(-1)).toMatchObject({ where: { id: "bb1", workspaceSlug: "acme" }, data: { setupStatus: { sync: { status: "failed" } } } });
    expect(upserts).toHaveLength(0);
    expect(updateManys).toHaveLength(0);
  });

  it("persists GitLab per-project readiness when another project's webhook fails", async () => {
    gitlab = { id: "gl1", gitlabHost: "https://gitlab.example.test", namespacePath: "acme", webhookSecret: "fixture-secret" };
    existingRows.gitlab = [{ externalId: "1", dismissedAt: null, webhookSetupStatus: { hookId: "99", hookScope: "gl1:https://gitlab.example.test:acme/good" } }];
    glProjects = [{ id: 1, name: "good", path_with_namespace: "acme/good" }, { id: 2, name: "bad", path_with_namespace: "acme/bad" }];
    glFailedProjects.add("acme/bad");
    const result = await syncOrgRepos("org_1", { source: "manual", providers: ["gitlab"] });
    expect(result.error).toContain("1 of 2 GitLab project webhooks need attention");
    expect(createProjectWebhook.mock.calls[0][4]).toMatchObject({ id: "gl1" });
    expect(updateManys.filter(u => u.data.webhookSetupStatus).map(u => [u.where.externalId, u.data.webhookSetupStatus.status])).toEqual([["1", "ready"], ["2", "failed"]]);
    expect(setupUpdates.at(-1)?.data.setupStatus).toMatchObject({ sync: { status: "ready" }, webhook: { status: "failed" } });
  });

  it("does not reuse GitLab hook IDs saved for a different host or project", async () => {
    gitlab = { id: "gl1", gitlabHost: "https://gitlab.example.test", namespacePath: "acme", webhookSecret: "fixture-secret" };
    existingRows.gitlab = [
      { externalId: "1", dismissedAt: null, webhookSetupStatus: { hookId: "99", hookScope: "https://old.example.test:acme/good" } },
      { externalId: "2", dismissedAt: null, webhookSetupStatus: { hookId: "98", hookScope: "https://gitlab.example.test:old/project" } },
    ];
    glProjects = [{ id: 1, name: "good", path_with_namespace: "acme/good" }, { id: 2, name: "moved", path_with_namespace: "acme/moved" }];
    await syncOrgRepos("org_1", { source: "manual", providers: ["gitlab"] });
    expect(createProjectWebhook.mock.calls.map(call => call[4].id)).toEqual(["gl1", "gl1"]);
    expect(updateManys.filter(u => u.data.webhookSetupStatus).map(u => u.data.webhookSetupStatus.hookScope))
      .toEqual(["gl1:https://gitlab.example.test:acme/good", "gl1:https://gitlab.example.test:acme/moved"]);
  });

  it("does not apply a listing to a replacement Bitbucket or GitLab connection", async () => {
    bitbucket = { id: "bb-old", workspaceSlug: "old", webhookSecret: "fixture-secret" };
    bbRepos = [{ uuid: "1", name: "repo", full_name: "old/repo" }];
    afterBitbucketListing = () => { bitbucket = { id: "bb-new", workspaceSlug: "new", webhookSecret: "fixture-secret" }; };
    await syncOrgRepos("org_1", { source: "manual", providers: ["bitbucket"] });
    expect(upserts).toHaveLength(0);
    expect(updateManys).toHaveLength(0);
    expect(setupUpdates.at(-1)?.where).toMatchObject({ id: "bb-old", workspaceSlug: "old" });
    gitlab = { id: "gl-old", gitlabHost: "https://gitlab.example.test", namespacePath: "old", webhookSecret: "fixture-secret" };
    glProjects = [{ id: 2, name: "repo", path_with_namespace: "old/repo" }];
    afterGitlabListing = () => { gitlab = { id: "gl-new", gitlabHost: "https://gitlab.example.test", namespacePath: "new", webhookSecret: "fixture-secret" }; };
    await syncOrgRepos("org_1", { source: "manual", providers: ["gitlab"] });
    expect(upserts).toHaveLength(0);
    expect(updateManys).toHaveLength(0);
    expect(setupUpdates.at(-1)?.where).toMatchObject({ id: "gl-old", namespacePath: "old" });
  });

  it("reports no providers when nothing is linked and calls no provider", async () => {
    orgRow = { githubInstallationId: null };
    const r = await syncOrgRepos("org_1", { source: "manual" });
    expect(r).toEqual({ synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] });
    expect(listInstallationRepos).not.toHaveBeenCalled();
    expect(grantDeferredWelcomeCredit).not.toHaveBeenCalled();
  });

  it("audits and notifies once when repositories were discovered, never when nothing is new", async () => {
    ghRepos[111] = [gh(1, "a"), gh(2, "b")];
    await syncOrgRepos("org_1", { source: "webhook" });
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({
      action: "repo.discovered",
      category: "repo",
      organizationId: "org_1",
      metadata: { source: "webhook", count: 2, repos: ["acme/a", "acme/b"] },
    });
    expect(trigger).toHaveBeenCalledWith("presence-org-org_1", "repos-discovered", { count: 2 });

    writeAuditLog.mockClear();
    enqueuePendingRepositoryIndexes.mockClear();
    trigger.mockClear();
    existingRows.github = [{ externalId: "1", dismissedAt: null }, { externalId: "2", dismissedAt: null }];
    await syncOrgRepos("org_1", { source: "webhook" });
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("applyRepositoryEvent (GitHub repository webhooks)", () => {
  beforeEach(() => {
    existingRows = { github: [], bitbucket: [], gitlab: [] };
    upserts.length = 0;
    updateManys.length = 0;
    updateManyCount = 1;
    grantDeferredWelcomeCredit.mockClear();
    trigger.mockClear();
    writeAuditLog.mockClear();
    enqueuePendingRepositoryIndexes.mockClear();
  });

  it("writes one row from the payload on created and announces it", async () => {
    const outcome = await applyRepositoryEvent("org_1", 111, "created", {
      id: 42,
      name: "fresh",
      full_name: "acme/fresh",
      default_branch: "trunk",
    });
    expect(outcome).toBe("created");
    expect(upserts).toHaveLength(1);
    expect(upserts[0].create).toMatchObject({ externalId: "42", defaultBranch: "trunk", installationId: 111, provider: "github" });
    expect(grantDeferredWelcomeCredit).toHaveBeenCalledWith("org_1");
    expect(writeAuditLog.mock.calls[0][0]).toMatchObject({ action: "repo.discovered", metadata: { source: "webhook", count: 1 } });
    expect(trigger).toHaveBeenCalledWith("presence-org-org_1", "repos-discovered", { count: 1 });
  });

  it("refreshes an existing row on rename without announcing, and never touches a dismissed one", async () => {
    existingRows.github = [{ externalId: "42", dismissedAt: null }, { externalId: "43", dismissedAt: new Date() }];
    expect(await applyRepositoryEvent("org_1", 111, "renamed", { id: 42, name: "renamed", full_name: "acme/renamed" })).toBe("updated");
    expect(upserts[0].update).toMatchObject({ fullName: "acme/renamed" });
    // No default_branch in the payload → the stored branch is left untouched.
    expect("defaultBranch" in upserts[0].update).toBe(false);
    expect(writeAuditLog).not.toHaveBeenCalled();
    expect(await applyRepositoryEvent("org_1", 111, "created", { id: 43, name: "back", full_name: "acme/back" })).toBe("dismissed");
    expect(upserts).toHaveLength(1);
  });

  it("deactivates (never deletes) on deleted and ignores unrelated actions", async () => {
    expect(await applyRepositoryEvent("org_1", 111, "deleted", { id: 7, name: "gone", full_name: "acme/gone" })).toBe("deactivated");
    expect(updateManys[0]).toMatchObject({
      where: { organizationId: "org_1", provider: "github", externalId: "7", isActive: true, dismissedAt: null },
      data: { isActive: false },
    });
    expect(await applyRepositoryEvent("org_1", 111, "archived", { id: 7, name: "gone", full_name: "acme/gone" })).toBe("ignored");
  });
});
