"use server";

import "server-only";
import { withWebhookSetupLock } from "@/lib/integration-setup-lock";
import { randomBytes } from "node:crypto";
import { headers, cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { hasOrgPermission } from "@/lib/org-permissions";
import { decryptStringMaybeLegacy, encryptString } from "@/lib/crypto";
import { validateForgejoConnection } from "@/lib/forgejo";
import { normalizeForgejoHost as normalizeConnectorHost } from "@octopus/forgejo-connector/http";
import { createConnectorToken, hashConnectorToken } from "@/lib/forgejo-connector";
import { normalizeForgejoHost } from "@/lib/forgejo-http";
import { syncForgejoRepos } from "@/lib/repo-sync";

async function getAdminOrg() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session) redirect("/login");

  const cookieStore = await cookies();
  const orgId = cookieStore.get("current_org_id")?.value;
  if (!orgId) return null;

  const member = await prisma.organizationMember.findFirst({
    where: { userId: session.user.id, organizationId: orgId, deletedAt: null, organization: { deletedAt: null, bannedAt: null } },
    select: { role: true, organizationId: true },
  });

  if (!member || !hasOrgPermission(member, "integrations:manage")) {
    return null;
  }

  return { orgId: member.organizationId };
}

/** Check only the selected provider; authorization is retained if setup fails. */
export async function retryIntegrationSetup(provider: "github" | "bitbucket" | "gitlab" | "forgejo"): Promise<{ error?: string; synced?: number }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  if (!["github", "bitbucket", "gitlab", "forgejo"].includes(provider)) {
    return { error: "Choose a supported code provider." };
  }
  try {
    const where = { organizationId: ctx.orgId };
    const connected = provider === "github"
      ? (await prisma.organization.findUnique({ where: { id: ctx.orgId }, select: { githubInstallationId: true } }))?.githubInstallationId
      : provider === "bitbucket"
        ? await prisma.bitbucketIntegration.findUnique({ where, select: { id: true } })
        : provider === "gitlab"
          ? await prisma.gitlabIntegration.findUnique({ where, select: { id: true } })
          : await prisma.forgejoIntegration.findUnique({ where, select: { id: true } });
    if (!connected) return { error: "Connect this provider before checking setup." };
    const { syncOrgRepos } = await import("@/lib/repo-sync");
    const result = await syncOrgRepos(ctx.orgId, { source: "manual", providers: [provider] });
    return { synced: result.synced, ...(result.error ? { error: result.error } : {}) };
  } catch {
    return { error: "Setup could not be completed. Check the provider connection and try again. Your authorization has been kept." };
  } finally {
    revalidatePath("/settings/integrations");
    revalidatePath("/repositories");
    revalidatePath("/dashboard");
  }
}

/** Retrieve the existing signing secret only after an administrator asks for it. */
export async function getIntegrationWebhookDetails(provider: "bitbucket" | "gitlab"): Promise<{
  error?: string;
  details?: { url: string; secret: string; description?: string; hookId?: string | null };
}> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  if (provider !== "bitbucket" && provider !== "gitlab") return { error: "Choose Bitbucket or GitLab." };
  try {
    const appUrl = process.env.BETTER_AUTH_URL;
    if (!appUrl) return { error: "The Octopus application URL is not configured. Ask the instance administrator to set BETTER_AUTH_URL before repairing webhooks." };
    if (provider === "bitbucket") {
      const integration = await prisma.bitbucketIntegration.findUnique({
        where: { organizationId: ctx.orgId }, select: { id: true, webhookSecret: true, webhookUuid: true },
      });
      if (!integration?.webhookSecret) return { error: "No saved Bitbucket webhook secret was found. Reconnect Bitbucket before retrying setup." };
      return { details: { url: `${appUrl}/api/bitbucket/webhook`, secret: integration.webhookSecret,
        description: `Octopus Review (${ctx.orgId}) [${integration.id}]`, hookId: integration.webhookUuid } };
    }
    const integration = await prisma.gitlabIntegration.findUnique({
      where: { organizationId: ctx.orgId }, select: { id: true, webhookSecret: true },
    });
    if (!integration?.webhookSecret) return { error: "No saved GitLab webhook secret was found. Reconnect GitLab before retrying setup." };
    const url = new URL(`${appUrl}/api/gitlab/webhook`);
    url.searchParams.set("octopus_org", ctx.orgId);
    url.searchParams.set("octopus_connection", integration.id);
    return { details: { url: url.toString(), secret: integration.webhookSecret } };
  } catch {
    return { error: "Webhook details could not be loaded. Try again in a moment." };
  }
}

// ── Forgejo Actions ──

export async function connectForgejo(formData: FormData): Promise<{ error?: string; synced?: number }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  const rawHost = formData.get("host");
  const rawToken = formData.get("token");
  if (typeof rawHost !== "string" || typeof rawToken !== "string" ||
      !rawHost.trim() || !rawToken.trim() || rawHost.length > 2048 || rawToken.length > 4096) {
    return { error: "Enter your Forgejo instance URL and personal access token." };
  }
  try {
    const host = normalizeForgejoHost(rawHost);
    const existing = await prisma.forgejoIntegration.findUnique({ where: { organizationId: ctx.orgId } });
    if (existing?.connectorTokenHash) return { error: "Disconnect the private connector before changing to a direct connection." };
    if (existing && existing.forgejoHost !== host) {
      return { error: "Disconnect your current Forgejo instance before connecting another host." };
    }
    const connection = await validateForgejoConnection(host, rawToken.trim());
    if (existing && existing.username.toLowerCase() !== connection.username.toLowerCase()) {
      return { error: "Disconnect your current Forgejo account before connecting another account." };
    }
    const accessTokenEnc = encryptString(rawToken.trim());
    await prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.forgejoIntegration.update({ where: { id: existing.id }, data: { accessTokenEnc } });
      } else {
        await tx.forgejoIntegration.create({ data: {
          organizationId: ctx.orgId,
          forgejoHost: connection.host,
          username: connection.username,
          accessTokenEnc,
          webhookSecret: randomBytes(32).toString("hex"),
        } });
      }
      // Old credentials may have broader access than a replacement token.
      await tx.repository.updateMany({
        where: { organizationId: ctx.orgId, provider: "forgejo" },
        data: { isActive: false },
      });
    });
  } catch {
    return { error: "Could not connect to Forgejo. Check the HTTPS URL, network access, token and read:user, write:repository and write:issue permissions. For private LAN/VPN, choose the local connector or configure direct access on self-hosted Octopus." };
  }
  return syncForgejo();
}

/** Connector tokens authorize only this integration's API requests, never an org API. */
export async function createForgejoConnector(formData: FormData): Promise<{ error?: string; connectorToken?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  const rawHost = formData.get("host");
  if (typeof rawHost !== "string" || rawHost.length > 2048) return { error: "Enter your Forgejo HTTPS origin." };
  try {
    // Syntax/address validation only. Cloud never resolves or connects to this private host.
    const forgejoHost = normalizeConnectorHost(rawHost, { allowPrivate: true });
    const connectorToken = createConnectorToken();
    await prisma.forgejoIntegration.create({ data: {
      organizationId: ctx.orgId, forgejoHost, username: "", accessTokenEnc: null,
      connectorTokenHash: hashConnectorToken(connectorToken), webhookSecret: randomBytes(32).toString("hex"),
    } });
    revalidatePath("/settings/integrations");
    return { connectorToken };
  } catch {
    return { error: "Could not create the connector. Use an HTTPS origin and disconnect any existing Forgejo connection first. Loopback and link-local addresses are not supported." };
  }
}

export async function rotateForgejoConnector(integrationId: string): Promise<{ error?: string; connectorToken?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  const connectorToken = createConnectorToken();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "forgejo_integrations" WHERE "id" = ${integrationId} AND "organizationId" = ${ctx.orgId} FOR UPDATE`;
    const integration = await tx.forgejoIntegration.findFirst({ where: { id: integrationId, organizationId: ctx.orgId, connectorTokenHash: { not: null } } });
    if (!integration) return { error: "This connector is no longer connected." };
    const pendingWrite = await tx.forgejoConnectorRequest.findFirst({ where: { integrationId, method: { not: "GET" }, OR: [{ status: { in: ["leased", "completed", "delivered", "publishing"] } }, { status: "uncertain", leaseExpiresAt: { gt: new Date() } }] }, select: { id: true } });
    if (pendingWrite) return { error: "A Forgejo write is still awaiting a result. Wait for it to finish, or check Forgejo and resume the paused connector before rotating." };
    await tx.forgejoConnectorRequest.deleteMany({ where: { integrationId } });
    await tx.forgejoIntegration.update({ where: { id: integrationId }, data: { connectorTokenHash: hashConnectorToken(connectorToken), connectorLastSeenAt: null } });
    return { connectorToken };
  });
  revalidatePath("/settings/integrations");
  return result;
}

export async function resumeForgejoConnector(integrationId: string): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "forgejo_integrations" WHERE "id" = ${integrationId} AND "organizationId" = ${ctx.orgId} FOR UPDATE`;
    const integration = await tx.forgejoIntegration.findFirst({ where: { id: integrationId, organizationId: ctx.orgId, connectorTokenHash: { not: null } } });
    if (!integration) return { error: "This connector is no longer connected." };
    if (!integration.connectorError) return { error: "This connector is not paused." };
    const active = await tx.forgejoConnectorRequest.findFirst({ where: { integrationId, OR: [
      { status: { in: ["leased", "uncertain"] }, leaseExpiresAt: { gt: new Date() } },
      { status: { in: ["delivered", "publishing"] }, expiresAt: { gt: new Date() } },
    ] }, select: { id: true } });
    if (active) return { error: "A connector request is still running. Wait 30 seconds, then check Forgejo again before resuming." };
    await tx.forgejoConnectorRequest.deleteMany({ where: { integrationId } });
    await tx.forgejoIntegration.update({ where: { id: integrationId }, data: { connectorError: null } });
    return {};
  });
  revalidatePath("/settings/integrations");
  return result;
}

export async function syncForgejo(): Promise<{ error?: string; synced?: number }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  try {
    const result = await syncForgejoRepos(ctx.orgId, { source: "manual" });
    revalidatePath("/settings/integrations");
    revalidatePath("/dashboard");
    revalidatePath("/repositories");
    return { synced: result.synced, ...(result.error ? { error: result.error } : {}) };
  } catch {
    revalidatePath("/settings/integrations");
    revalidatePath("/dashboard");
    revalidatePath("/repositories");
    return { error: "Forgejo is connected, but repository sync failed. Check the token permissions and instance availability, then retry Sync repositories." };
  }
}

export async function disconnectForgejo(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };
  await prisma.$transaction(async (tx) => {
    // Serialize with sync and connector claim/result before revoking credentials.
    await tx.$queryRaw`SELECT "id" FROM "forgejo_integrations" WHERE "organizationId" = ${ctx.orgId} FOR UPDATE`;
    await tx.forgejoIntegration.deleteMany({ where: { organizationId: ctx.orgId } });
    await tx.repository.updateMany({
      where: { organizationId: ctx.orgId, provider: "forgejo" },
      data: { isActive: false },
    });
  });
  revalidatePath("/settings/integrations");
  revalidatePath("/dashboard");
  revalidatePath("/repositories");
  return {};
}

// ── Slack Actions ──

export async function disconnectSlack(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.slackIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true, accessToken: true },
  });

  if (!integration) return { error: "No Slack integration found." };

  // Revoke the token (best-effort)
  try {
    await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decryptStringMaybeLegacy(integration.accessToken)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
  } catch (err) {
    console.error("[slack] Token revoke failed:", err);
  }

  // Cascade deletes event configs
  await prisma.slackIntegration.delete({
    where: { id: integration.id },
  });

  revalidatePath("/settings/integrations");
  return {};
}

export async function updateSlackChannel(
  formData: FormData,
): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const channelId = formData.get("channelId") as string;
  const channelName = formData.get("channelName") as string;

  if (!channelId) return { error: "Please select a channel." };

  await prisma.slackIntegration.update({
    where: { organizationId: ctx.orgId },
    data: { channelId, channelName },
  });

  revalidatePath("/settings/integrations");
  return {};
}

export async function toggleSlackEvent(
  eventType: string,
  enabled: boolean,
): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.slackIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true },
  });

  if (!integration) return { error: "No Slack integration found." };

  await prisma.slackEventConfig.upsert({
    where: {
      slackIntegrationId_eventType: {
        slackIntegrationId: integration.id,
        eventType,
      },
    },
    create: {
      eventType,
      enabled,
      slackIntegrationId: integration.id,
    },
    update: { enabled },
  });

  revalidatePath("/settings/integrations");
  return {};
}

// ── GitLab Actions ──

function normalizeGitlabHost(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let host = raw.trim();
  if (!host) return null;
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  host = host.replace(/\/+$/, "");
  try {
    const url = new URL(host);
    if (url.pathname !== "/" && url.pathname !== "") return null;
    if (url.search || url.hash) return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

const GITLAB_OAUTH_INIT_COOKIE = "gitlab_oauth_init";

export async function startGitlabOAuth(formData: FormData): Promise<void> {
  const ctx = await getAdminOrg();
  if (!ctx) {
    redirect("/settings/integrations?error=forbidden");
  }

  const namespacePath = String(formData.get("namespace") ?? "").trim();
  const hostInput = String(formData.get("host") ?? "");
  const customClientId = String(formData.get("clientId") ?? "").trim();
  const customClientSecret = String(formData.get("clientSecret") ?? "");

  if (!namespacePath) {
    redirect("/settings/integrations?error=missing_namespace");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(namespacePath) || namespacePath.length > 200) {
    redirect("/settings/integrations?error=invalid_namespace");
  }

  const gitlabHost = normalizeGitlabHost(hostInput) ?? "https://gitlab.com";
  const isCloud = gitlabHost === "https://gitlab.com";

  // Pick OAuth credentials: per-org for self-hosted, env defaults for gitlab.com
  let clientId: string;
  let clientSecretToStore: string | null = null;

  if (!isCloud || customClientId) {
    if (!customClientId || !customClientSecret) {
      redirect("/settings/integrations?error=missing_oauth_creds");
    }
    clientId = customClientId;
    clientSecretToStore = customClientSecret;
  } else {
    const envClientId = process.env.GITLAB_CLIENT_ID;
    if (!envClientId) {
      redirect("/settings/integrations?error=not_configured");
    }
    clientId = envClientId;
  }

  const redirectUri = process.env.GITLAB_REDIRECT_URI;
  if (!redirectUri) {
    redirect("/settings/integrations?error=not_configured");
  }

  // Encrypted, short-lived cookie carries the secret + nonce + context.
  // Never put the secret in the OAuth state URL.
  const { encryptJson } = await import("@/lib/crypto");
  const cryptoNode = await import("node:crypto");
  const nonce = cryptoNode.randomBytes(16).toString("hex");

  const cookiePayload = encryptJson({
    nonce,
    orgId: ctx.orgId,
    namespacePath,
    gitlabHost,
    clientId,
    clientSecret: clientSecretToStore,
    issuedAt: Date.now(),
  });

  const cookieStore = await cookies();
  cookieStore.set(GITLAB_OAUTH_INIT_COOKIE, cookiePayload, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });

  // State carries only the nonce — callback re-derives everything else from the cookie.
  const state = Buffer.from(JSON.stringify({ nonce })).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: "api read_api read_user read_repository write_repository",
  });

  redirect(`${gitlabHost}/oauth/authorize?${params.toString()}`);
}

export async function disconnectGitlab(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  try {
    await withWebhookSetupLock(`binding:gitlab:${ctx.orgId}`, async (tx) => {
      await tx.gitlabIntegration.deleteMany({ where: { organizationId: ctx.orgId } });
      await tx.repository.updateMany({
        where: { organizationId: ctx.orgId, provider: "gitlab" },
        data: { isActive: false, webhookSetupStatus: { status: "unknown" } },
      });
    });
  } catch {
    return { error: "Connection setup is running or the disconnect failed. Retry shortly." };
  }

  revalidatePath("/settings/integrations");
  return {};
}

// ── Bitbucket Actions ──

export async function disconnectBitbucket(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  try {
    await withWebhookSetupLock(`binding:bitbucket:${ctx.orgId}`, async (tx) => {
      await tx.bitbucketIntegration.deleteMany({ where: { organizationId: ctx.orgId } });
      await tx.repository.updateMany({
        where: { organizationId: ctx.orgId, provider: "bitbucket" },
        data: { isActive: false, webhookSetupStatus: { status: "unknown" } },
      });
    });
  } catch {
    return { error: "Connection setup is running or the disconnect failed. Retry shortly." };
  }

  revalidatePath("/settings/integrations");
  return {};
}

// ── GitHub Actions ──

export async function disconnectGitHub(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const org = await prisma.organization.findUnique({
    where: { id: ctx.orgId },
    select: { githubInstallationId: true },
  });

  if (!org?.githubInstallationId) return { error: "No GitHub integration found." };

  // Remove installation ID from org and all repo rows so that a subsequent
  // syncRepos cannot silently re-fetch and reactivate them via per-repo id.
  await prisma.$transaction([
    prisma.organization.update({
      where: { id: ctx.orgId },
      data: { githubInstallationId: null },
    }),
    prisma.repository.updateMany({
      where: {
        organizationId: ctx.orgId,
        provider: "github",
      },
      data: { isActive: false, installationId: null },
    }),
  ]);

  revalidatePath("/settings/integrations");
  return {};
}

// ── Collab Actions ──

const COLLAB_BASE_URL = "https://mcp-collab.weez.boo";

export async function connectCollab(
  formData: FormData,
): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const apiKey = (formData.get("apiKey") as string)?.trim();

  if (!apiKey) return { error: "Token is required." };

  // Fetch workspace info to validate token and get workspace ID
  let workspaceId: string | null = null;
  let workspaceName: string | null = null;

  try {
    const { listCollabWorkspaces } = await import("@/lib/collab");
    const workspaces = await listCollabWorkspaces(apiKey);
    if (workspaces.length > 0) {
      workspaceId = workspaces[0].id;
      workspaceName = workspaces[0].name;
    }
  } catch {
    return { error: "Invalid token or could not reach Collab server." };
  }

  await prisma.collabIntegration.upsert({
    where: { organizationId: ctx.orgId },
    create: {
      apiKey,
      baseUrl: COLLAB_BASE_URL,
      workspaceId,
      workspaceName,
      isActive: true,
      organizationId: ctx.orgId,
    },
    update: {
      apiKey,
      baseUrl: COLLAB_BASE_URL,
      workspaceId,
      workspaceName,
      isActive: true,
    },
  });

  revalidatePath("/settings/integrations");
  return {};
}

export async function disconnectCollab(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.collabIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true },
  });

  if (!integration) return { error: "No Collab integration found." };

  // Cascade deletes project mappings
  await prisma.collabIntegration.delete({
    where: { id: integration.id },
  });

  revalidatePath("/settings/integrations");
  return {};
}

export async function updateCollabMapping(
  formData: FormData,
): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const repositoryId = formData.get("repositoryId") as string;
  const collabProjectId = (formData.get("collabProjectId") as string)?.trim();
  const collabProjectName = (formData.get("collabProjectName") as string)?.trim();

  if (!repositoryId) return { error: "Repository is required." };
  if (!collabProjectId) return { error: "Collab Project ID is required." };

  const integration = await prisma.collabIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true },
  });

  if (!integration) return { error: "No Collab integration found." };

  await prisma.collabProjectMapping.upsert({
    where: {
      collabIntegrationId_repositoryId: {
        collabIntegrationId: integration.id,
        repositoryId,
      },
    },
    create: {
      collabProjectId,
      collabProjectName: collabProjectName || collabProjectId,
      repositoryId,
      collabIntegrationId: integration.id,
    },
    update: {
      collabProjectId,
      collabProjectName: collabProjectName || collabProjectId,
    },
  });

  revalidatePath("/settings/integrations");
  return {};
}

export async function removeCollabMapping(
  repositoryId: string,
): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.collabIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true },
  });

  if (!integration) return { error: "No Collab integration found." };

  await prisma.collabProjectMapping.deleteMany({
    where: {
      collabIntegrationId: integration.id,
      repositoryId,
    },
  });

  revalidatePath("/settings/integrations");
  return {};
}

// ── Linear Actions ──

export async function disconnectLinear(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.linearIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true, workspaceName: true },
  });

  if (!integration) return { error: "No Linear integration found." };

  // Cascade deletes team mappings
  await prisma.linearIntegration.delete({
    where: { id: integration.id },
  });

  const { writeAuditLog } = await import("@/lib/audit");
  await writeAuditLog({
    action: "integration.disconnected",
    category: "system",
    organizationId: ctx.orgId,
    targetType: "LinearIntegration",
    targetId: integration.id,
    metadata: { provider: "linear", workspaceName: integration.workspaceName },
  });

  revalidatePath("/settings/integrations");
  return {};
}

// ── Jira Actions ──

export async function disconnectJira(): Promise<{ error?: string }> {
  const ctx = await getAdminOrg();
  if (!ctx) return { error: "Insufficient permissions." };

  const integration = await prisma.jiraIntegration.findUnique({
    where: { organizationId: ctx.orgId },
    select: { id: true, siteName: true, cloudId: true, refreshToken: true },
  });

  if (!integration) return { error: "No Jira integration found." };

  // Best-effort revoke
  const clientId = process.env.JIRA_CLIENT_ID;
  const clientSecret = process.env.JIRA_CLIENT_SECRET;
  if (clientId && clientSecret) {
    try {
      const { decryptJiraToken } = await import("@/lib/jira");
      const revokeResponse = await fetch(
        "https://auth.atlassian.com/oauth/token/revoke",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            token: decryptJiraToken(integration.refreshToken),
            token_type_hint: "refresh_token",
          }),
        },
      );
      // Consume body so the connection can be released even though we ignore
      // the result (revoke is best-effort).
      await revokeResponse.text().catch(() => "");
      if (!revokeResponse.ok) {
        console.warn(
          "[jira] Token revoke returned non-2xx:",
          revokeResponse.status,
        );
      }
    } catch (err) {
      console.error("[jira] Token revoke failed:", err);
    }
  }

  // Cascade deletes project mappings
  await prisma.jiraIntegration.delete({
    where: { id: integration.id },
  });

  const { writeAuditLog } = await import("@/lib/audit");
  await writeAuditLog({
    action: "integration.disconnected",
    category: "system",
    organizationId: ctx.orgId,
    targetType: "JiraIntegration",
    targetId: integration.id,
    metadata: {
      provider: "jira",
      siteName: integration.siteName,
      cloudId: integration.cloudId,
    },
  });

  revalidatePath("/settings/integrations");
  return {};
}
