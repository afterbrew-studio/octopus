import "server-only";
import { acquireWebhookSetupLock } from "@/lib/integration-setup-lock";
import { prisma } from "@octopus/db";
import { listInstallationRepos, GithubRateLimitError } from "@/lib/github";
import { listWorkspaceRepos, createWebhook } from "@/lib/bitbucket";
import { listNamespaceProjects, createProjectWebhook } from "@/lib/gitlab";
import { listUserRepos } from "@/lib/forgejo";
import { grantDeferredWelcomeCredit } from "@/lib/org-create";
// Namespace import: read at call time so a partial module double elsewhere in
// the test process cannot break module load.
import * as realtime from "@/lib/pubby";
import { writeAuditLog } from "@/lib/audit";
import { enqueuePendingRepositoryIndexes } from "@/lib/repository-index-job";
import { parseRepositoryWebhookSetup, WebhookSetupError, type IntegrationSetupStatus, type RepositoryWebhookSetup } from "@/lib/integration-setup";

/**
 * Org-scoped repository sync shared by the manual Sync button, the GitHub
 * webhook (installation / repository events) and the hourly
 * discover-repositories sweep. Lists every connected provider, upserts what it
 * finds, deactivates what disappeared, and reports which rows are new.
 *
 * Invariants:
 *  - a repository the user removed (`dismissedAt` set) is never resurrected;
 *  - repositories that vanished upstream are deactivated, never deleted, and
 *    only when every listing for that provider succeeded (a transient listing
 *    failure must not mass-deactivate an installation's repos);
 *  - no request-scoped side effects here (no revalidatePath): callers do that.
 */
export type RepoSyncSource = "manual" | "scheduled" | "webhook";
export type RepoSyncProvider = "github" | "bitbucket" | "gitlab" | "forgejo";

export interface DiscoveredRepo {
  id: string;
  fullName: string;
  provider: RepoSyncProvider;
}

export interface RepoSyncResult {
  error?: string;
  /** Rows created or refreshed. */
  synced: number;
  /** Rows that did not exist before this run. */
  created: number;
  /** Rows deactivated because the provider no longer lists them. */
  removed: number;
  createdRepos: DiscoveredRepo[];
  /** Providers that had an integration to sync; empty means nothing is linked. */
  providers: RepoSyncProvider[];
}

function setupStatus(syncError: string | null, webhook: IntegrationSetupStatus["webhook"]): IntegrationSetupStatus {
  return { sync: { status: syncError ? "failed" : "ready", checkedAt: new Date().toISOString(), error: syncError }, webhook };
}

function uncheckedWebhook(status: "unknown" | "manual" = "unknown"): IntegrationSetupStatus["webhook"] {
  return { status, checkedAt: null, error: null };
}

function reportError(result: RepoSyncResult, message: string) {
  result.error = result.error ? `${result.error} ${message}` : message;
}

function webhookError(error: unknown, fallback: string): string {
  return error instanceof WebhookSetupError ? error.message : fallback;
}

function mergeCounts(result: RepoSyncResult, synced: RepoSyncResult) {
  result.synced += synced.synced;
  result.created += synced.created;
  result.removed += synced.removed;
  result.createdRepos.push(...synced.createdRepos);
}

/** externalId → dismissedAt for the org's existing rows of one provider. */
async function loadExisting(organizationId: string, provider: RepoSyncProvider, db: Pick<typeof prisma, "repository"> = prisma) {
  const rows = await db.repository.findMany({
    where: { organizationId, provider },
    select: { externalId: true, dismissedAt: true },
  });
  return new Map(rows.map((r) => [r.externalId, r.dismissedAt]));
}

async function upsertRepo(
  organizationId: string,
  provider: RepoSyncProvider,
  existing: Map<string, Date | null>,
  result: RepoSyncResult,
  repo: { externalId: string; name: string; fullName: string; defaultBranch?: string; installationId?: number },
  db: Pick<typeof prisma, "repository"> = prisma,
): Promise<"created" | "updated" | "dismissed"> {
  if (existing.has(repo.externalId) && existing.get(repo.externalId) != null) return "dismissed";
  const isNew = !existing.has(repo.externalId);
  const row = await db.repository.upsert({
    where: {
      provider_externalId_organizationId: { provider, externalId: repo.externalId, organizationId },
    },
    create: {
      name: repo.name,
      fullName: repo.fullName,
      externalId: repo.externalId,
      defaultBranch: repo.defaultBranch ?? "main",
      provider,
      isActive: true,
      organizationId,
      ...(repo.installationId !== undefined ? { installationId: repo.installationId } : {}),
    },
    update: {
      name: repo.name,
      fullName: repo.fullName,
      // Only overwrite the stored default branch when the provider told us one;
      // a payload without it must not clobber a correct "master" with "main".
      ...(repo.defaultBranch !== undefined ? { defaultBranch: repo.defaultBranch } : {}),
      isActive: true,
      ...(repo.installationId !== undefined ? { installationId: repo.installationId } : {}),
    },
    select: { id: true, fullName: true },
  });
  result.synced++;
  if (isNew) {
    result.created++;
    result.createdRepos.push({ id: row.id, fullName: row.fullName, provider });
  }
  return isNew ? "created" : "updated";
}

async function deactivateMissing(
  organizationId: string,
  provider: RepoSyncProvider,
  presentIds: string[],
  /** GitHub only: restrict to rows belonging to the installations that were actually listed. */
  installationIds?: number[],
  db: Pick<typeof prisma, "repository"> = prisma,
) {
  const res = await db.repository.updateMany({
    where: {
      organizationId,
      provider,
      externalId: { notIn: presentIds },
      isActive: true,
      dismissedAt: null,
      ...(installationIds
        ? { OR: [{ installationId: null }, { installationId: { in: installationIds } }] }
        : {}),
    },
    data: { isActive: false },
  });
  return res.count;
}

export async function syncOrgRepos(
  organizationId: string,
  opts: { source: RepoSyncSource; providers?: RepoSyncProvider[] },
): Promise<RepoSyncResult> {
  const result: RepoSyncResult = { synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] };

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { githubInstallationId: true },
  });

  // ── GitHub ──
  // The org-level installation is the signed tenant authority (webhook-tenant.ts).
  // Repo-level installation ids are legacy data; only the manual button still
  // widens to them so existing users keep today's behaviour.
  const installationIds = new Set<number>();
  const selected = (provider: RepoSyncProvider) => !opts.providers || opts.providers.includes(provider);
  if (selected("github") && org?.githubInstallationId) installationIds.add(org.githubInstallationId);
  if (selected("github") && opts.source === "manual") {
    const repoInstallations = await prisma.repository.findMany({
      where: { organizationId, installationId: { not: null } },
      select: { installationId: true },
      distinct: ["installationId"],
    });
    for (const r of repoInstallations) if (r.installationId) installationIds.add(r.installationId);
  }

  if (installationIds.size > 0) {
    result.providers.push("github");
    const existing = await loadExisting(organizationId, "github");
    const present: string[] = [];
    let listingFailed = false;
    for (const installationId of installationIds) {
      try {
        const repos = await listInstallationRepos(installationId);
        for (const repo of repos) {
          const externalId = String(repo.id);
          present.push(externalId);
          await upsertRepo(organizationId, "github", existing, result, {
            externalId,
            name: repo.name,
            fullName: repo.full_name,
            defaultBranch: repo.default_branch,
            installationId,
          });
        }
      } catch (err) {
        // The sweep stops on a rate limit (cursor resumes next tick); a person
        // clicking Sync still gets the other providers synced.
        listingFailed = true;
        console.error(`[repo-sync] Failed to list repos for installation ${installationId}:`, err);
        if (err instanceof GithubRateLimitError && opts.source !== "manual") {
          await prisma.organization.updateMany({ where: { id: organizationId, githubInstallationId: org?.githubInstallationId },
            data: { githubSetupStatus: setupStatus("GitHub repository sync was rate limited. Retry shortly.", uncheckedWebhook()) } });
          throw err;
        }
      }
    }
    // Deactivate only rows the listing actually covered: rows tied to a legacy
    // installation this run did not list (non-manual sources) must stay put.
    if (!listingFailed) {
      result.removed += await deactivateMissing(organizationId, "github", present, [...installationIds]);
    }
    const error = listingFailed ? "GitHub repository sync failed. Check the App installation and repository access, then retry setup." : null;
    if (error) reportError(result, error);
    await prisma.organization.updateMany({ where: { id: organizationId, githubInstallationId: org?.githubInstallationId },
      data: { githubSetupStatus: setupStatus(error, uncheckedWebhook()) } });
  }

  // ── Bitbucket ──
  const bitbucket = selected("bitbucket") ? await prisma.bitbucketIntegration.findUnique({
    where: { organizationId },
  }) : null;
  if (bitbucket) {
    result.providers.push("bitbucket");
    try {
      const repos = await listWorkspaceRepos(organizationId, bitbucket.workspaceSlug);
      let hookId: string | null = null;
      let hookError: string | null = null;
      try {
        if (!bitbucket.webhookSecret) throw new WebhookSetupError("Bitbucket webhook secret is missing. Reconnect Bitbucket, then retry setup.");
        hookId = await createWebhook(organizationId, bitbucket.workspaceSlug,
          `${process.env.BETTER_AUTH_URL || "http://localhost:3000"}/api/bitbucket/webhook`, bitbucket.webhookSecret, bitbucket);
      } catch (error) {
        hookError = webhookError(error, "Could not check Bitbucket webhook setup. Retry setup after checking access and connectivity.");
      }
      const synced: RepoSyncResult = { synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] };
      await prisma.$transaction(async (tx) => {
        await acquireWebhookSetupLock(tx, `binding:bitbucket:${organizationId}`);
        await tx.$queryRaw`SELECT "id" FROM "bitbucket_integrations" WHERE "id" = ${bitbucket.id} FOR UPDATE`;
        const current = await tx.bitbucketIntegration.findUnique({ where: { organizationId } });
        if (!current || current.id !== bitbucket.id || current.workspaceSlug !== bitbucket.workspaceSlug || current.webhookSecret !== bitbucket.webhookSecret) throw new Error("Bitbucket connection changed during sync");
        const existing = await loadExisting(organizationId, "bitbucket", tx);
        const present: string[] = [];
        for (const repo of repos) {
          present.push(repo.uuid);
          await upsertRepo(organizationId, "bitbucket", existing, synced, {
            externalId: repo.uuid, name: repo.name, fullName: repo.full_name, defaultBranch: repo.mainbranch?.name ?? "main",
          }, tx);
        }
        synced.removed += await deactivateMissing(organizationId, "bitbucket", present, undefined, tx);
        await tx.bitbucketIntegration.update({ where: { id: bitbucket.id }, data: {
          ...(hookId ? { webhookUuid: hookId } : {}),
          setupStatus: setupStatus(null, { status: hookError ? "failed" : "ready", checkedAt: new Date().toISOString(), error: hookError }),
        } });
      }, { timeout: 60_000 });
      mergeCounts(result, synced);
      if (hookError) reportError(result, hookError);
    } catch (err) {
      console.error("[repo-sync] Failed to sync Bitbucket repos:", err);
      const error = "Bitbucket repository sync failed. Check workspace access and reconnect if needed, then retry setup.";
      reportError(result, error);
      await prisma.bitbucketIntegration.updateMany({ where: { id: bitbucket.id, workspaceSlug: bitbucket.workspaceSlug, webhookSecret: bitbucket.webhookSecret },
        data: { setupStatus: setupStatus(error, uncheckedWebhook()) } });
    }
  }

  // ── GitLab ──
  // Group hooks are Premium-only, so every project carries its own hook (same
  // per-org secret). New projects therefore need a row AND a hook.
  const gitlab = selected("gitlab") ? await prisma.gitlabIntegration.findUnique({
    where: { organizationId },
  }) : null;
  if (gitlab) {
    result.providers.push("gitlab");
    try {
      const projects = await listNamespaceProjects(organizationId, gitlab.namespacePath);
      const existingRows = await prisma.repository.findMany({ where: { organizationId, provider: "gitlab" },
        select: { externalId: true, dismissedAt: true, webhookSetupStatus: true } });
      const existing = new Map(existingRows.map(row => [row.externalId, row]));
      const appUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";
      const hooks = new Map<string, RepositoryWebhookSetup>();
      for (const project of projects) {
        const externalId = String(project.id);
        if (existing.get(externalId)?.dismissedAt) continue;
        const previous = parseRepositoryWebhookSetup(existing.get(externalId)?.webhookSetupStatus);
        // Numeric project/hook IDs can collide after reconnecting another GitLab host.
        const hookScope = `${gitlab.id}:${gitlab.gitlabHost}:${project.path_with_namespace}`;
        const knownHookId = previous.hookScope === hookScope ? previous.hookId : null;
        try {
          if (!gitlab.webhookSecret) throw new WebhookSetupError("GitLab webhook secret is missing. Reconnect GitLab, then retry setup.");
          const id = await createProjectWebhook(organizationId, project.path_with_namespace,
            `${appUrl}/api/gitlab/webhook`, gitlab.webhookSecret, gitlab);
          hooks.set(externalId, { status: "ready", checkedAt: new Date().toISOString(), error: null, hookId: String(id), hookScope });
        } catch (error) {
          hooks.set(externalId, { status: "failed", checkedAt: new Date().toISOString(), hookId: knownHookId, hookScope,
            error: webhookError(error, "Could not check this GitLab project's webhook. Check project access and connectivity, then retry setup.") });
        }
      }
      const failures = [...hooks.values()].filter(h => h.status === "failed");
      const hookError = failures.length ? `${failures.length} of ${hooks.size} GitLab project webhooks need attention. ${failures[0].error}` : null;
      const synced: RepoSyncResult = { synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] };
      await prisma.$transaction(async (tx) => {
        await acquireWebhookSetupLock(tx, `binding:gitlab:${organizationId}`);
        await tx.$queryRaw`SELECT "id" FROM "gitlab_integrations" WHERE "id" = ${gitlab.id} FOR UPDATE`;
        const current = await tx.gitlabIntegration.findUnique({ where: { organizationId } });
        if (!current || current.id !== gitlab.id || current.gitlabHost !== gitlab.gitlabHost || current.namespacePath !== gitlab.namespacePath || current.webhookSecret !== gitlab.webhookSecret) throw new Error("GitLab connection changed during sync");
        const dismissed = await loadExisting(organizationId, "gitlab", tx);
        const present: string[] = [];
        for (const project of projects) {
          const externalId = String(project.id);
          present.push(externalId);
          const outcome = await upsertRepo(organizationId, "gitlab", dismissed, synced, {
            externalId, name: project.name, fullName: project.path_with_namespace, defaultBranch: project.default_branch ?? "main",
          }, tx);
          const hook = hooks.get(externalId);
          if (outcome !== "dismissed" && hook) await tx.repository.updateMany({
            where: { organizationId, provider: "gitlab", externalId, dismissedAt: null }, data: { webhookSetupStatus: hook },
          });
        }
        synced.removed += await deactivateMissing(organizationId, "gitlab", present, undefined, tx);
        await tx.gitlabIntegration.update({ where: { id: gitlab.id }, data: { setupStatus: setupStatus(null,
          { status: hookError ? "failed" : hooks.size ? "ready" : "unknown", checkedAt: new Date().toISOString(), error: hookError }) } });
      }, { timeout: 60_000 });
      mergeCounts(result, synced);
      if (hookError) reportError(result, hookError);
    } catch (err) {
      console.error("[repo-sync] Failed to sync GitLab projects:", err);
      const error = "GitLab repository sync failed. Check namespace access and reconnect if needed, then retry setup.";
      reportError(result, error);
      await prisma.gitlabIntegration.updateMany({ where: { id: gitlab.id, gitlabHost: gitlab.gitlabHost, namespacePath: gitlab.namespacePath, webhookSecret: gitlab.webhookSecret },
        data: { setupStatus: setupStatus(error, uncheckedWebhook()) } });
    }
  }

  // Arbitrary self-hosted identities must not unlock welcome credits.
  if (result.synced > 0) await grantDeferredWelcomeCredit(organizationId);

  notifyDiscovered(organizationId, opts.source, result.createdRepos);
  if (selected("github")) await enqueuePendingRepositoryIndexes(organizationId, undefined, ["github"])
    .catch((err) => console.error("[repo-sync] Could not queue indexing; next sync will retry:", err));

  const forgejo = selected("forgejo") ? await syncForgejoRepos(organizationId, opts).catch((err) => {
    console.error("[repo-sync] Failed to sync Forgejo repos:", err);
    reportError(result, "Forgejo repository sync failed. Check its token permissions and instance availability in Settings → Integrations.");
    return null;
  }) : null;
  if (forgejo) {
    mergeCounts(result, forgejo);
    result.providers.push(...forgejo.providers);
  }

  return result;
}

/** Fetch outside the transaction, then fence disconnect/token changes before writing. */
export async function syncForgejoRepos(
  organizationId: string,
  opts: { source: RepoSyncSource },
): Promise<RepoSyncResult> {
  const integration = await prisma.forgejoIntegration.findUnique({ where: { organizationId } });
  const result: RepoSyncResult = { synced: 0, created: 0, removed: 0, createdRepos: [], providers: [] };
  if (!integration) return result;
  try {
    const repos = await listUserRepos(organizationId);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "forgejo_integrations" WHERE "id" = ${integration.id} FOR UPDATE`;
      const current = await tx.forgejoIntegration.findUnique({ where: { organizationId }, include: { organization: { select: { bannedAt: true, deletedAt: true } } } });
      if (!current || current.organization.bannedAt || current.organization.deletedAt || current.connectorError
        || current.id !== integration.id || current.accessTokenEnc !== integration.accessTokenEnc
        || current.connectorTokenHash !== integration.connectorTokenHash || current.username !== integration.username) {
        throw new Error("Forgejo connection changed during sync. Try syncing again.");
      }
      result.providers.push("forgejo");
      const existing = await loadExisting(organizationId, "forgejo", tx);
      const present: string[] = [];
      for (const repo of repos) {
        if (!repo.permissions?.admin || repo.archived) continue;
        const externalId = `${integration.forgejoHost}:${repo.id}`;
        present.push(externalId);
        await upsertRepo(organizationId, "forgejo", existing, result, {
          externalId,
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch || "main",
        }, tx);
      }
      result.removed += await deactivateMissing(organizationId, "forgejo", present, undefined, tx);
      await tx.forgejoIntegration.update({ where: { id: integration.id }, data: { setupStatus: setupStatus(null, uncheckedWebhook("manual")) } });
    });
    notifyDiscovered(organizationId, opts.source, result.createdRepos);
    await enqueuePendingRepositoryIndexes(organizationId, undefined, ["forgejo"])
      .catch((err) => console.error("[repo-sync] Could not queue Forgejo indexing:", err));
    return result;
  } catch (error) {
    await prisma.forgejoIntegration.updateMany({ where: { id: integration.id, forgejoHost: integration.forgejoHost, accessTokenEnc: integration.accessTokenEnc,
      connectorTokenHash: integration.connectorTokenHash, username: integration.username },
      data: { setupStatus: setupStatus("Forgejo repository sync failed. Check its token permissions and instance or connector availability, then retry setup.", uncheckedWebhook("manual")) } });
    throw error;
  }
}

/** One audit row + one realtime event per run that created repositories. */
function notifyDiscovered(organizationId: string, source: RepoSyncSource, createdRepos: DiscoveredRepo[]) {
  if (createdRepos.length === 0) return;
  void writeAuditLog({
    action: "repo.discovered",
    category: "repo",
    organizationId,
    targetType: "Organization",
    targetId: organizationId,
    metadata: {
      source,
      count: createdRepos.length,
      repos: createdRepos.slice(0, 50).map((r) => r.fullName),
    },
  }).catch(() => {});
  // Count only: the page re-fetches on this event, and an uncapped id list
  // would exceed realtime message limits on a large first sync.
  if (realtime.PUBBY_ENABLED) {
    realtime.pubby
      .trigger(`presence-org-${organizationId}`, "repos-discovered", { count: createdRepos.length })
      .catch((err: unknown) => console.warn("[repo-sync] realtime notify failed:", err));
  }
}

export type RepositoryEventOutcome = "created" | "updated" | "dismissed" | "deactivated" | "ignored";

/**
 * Fast path for GitHub `repository` webhooks (created / renamed / transferred /
 * deleted). The payload already carries id, name, full_name and default_branch,
 * so one row is written without listing the whole installation. Same
 * invariants as syncOrgRepos: dismissed rows are never resurrected, deletion
 * only deactivates, a newly created row is audited and announced.
 */
export async function applyRepositoryEvent(
  organizationId: string,
  installationId: number,
  action: string,
  repo: { id: number; name: string; full_name: string; default_branch?: string | null },
): Promise<RepositoryEventOutcome> {
  const externalId = String(repo.id);
  if (action === "deleted") {
    const res = await prisma.repository.updateMany({
      where: { organizationId, provider: "github", externalId, isActive: true, dismissedAt: null },
      data: { isActive: false },
    });
    return res.count > 0 ? "deactivated" : "ignored";
  }
  if (!["created", "renamed", "transferred"].includes(action)) return "ignored";

  const row = await prisma.repository.findUnique({
    where: { provider_externalId_organizationId: { provider: "github", externalId, organizationId } },
    select: { dismissedAt: true },
  });
  const existing = new Map<string, Date | null>(row ? [[externalId, row.dismissedAt]] : []);
  const result: RepoSyncResult = { synced: 0, created: 0, removed: 0, createdRepos: [], providers: ["github"] };
  const outcome = await upsertRepo(organizationId, "github", existing, result, {
    externalId,
    name: repo.name,
    fullName: repo.full_name,
    ...(repo.default_branch ? { defaultBranch: repo.default_branch } : {}),
    installationId,
  });
  if (outcome === "created") {
    await grantDeferredWelcomeCredit(organizationId);
    notifyDiscovered(organizationId, "webhook", result.createdRepos);
  }
  if (outcome !== "dismissed") {
    await enqueuePendingRepositoryIndexes(organizationId)
      .catch((err) => console.error("[repo-sync] Could not queue indexing; next sync will retry:", err));
  }
  return outcome;
}
