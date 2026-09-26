import "server-only";
import { headers, cookies } from "next/headers";
import { ForgejoIntegrationCard } from "./forgejo-integration-card";
import { hasOrgPermission } from "@/lib/org-permissions";
import { GITHUB_INSTALL_ERROR_CODES, type GitHubInstallErrorCode } from "@/lib/github-install-errors";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@octopus/db";
import { GitHubIntegrationCard } from "./github-integration-card";
import { SlackIntegrationCard } from "./slack-integration-card";
import { BitbucketIntegrationCard } from "./bitbucket-integration-card";
import { GitlabIntegrationCard } from "./gitlab-integration-card";
import { LinearIntegrationCard } from "./linear-integration-card";
import { JiraIntegrationCard } from "./jira-integration-card";
import { IntegrationOAuthErrorBanner } from "./integration-oauth-error-banner";
import { getGithubAppConfig } from "@/lib/github-app-config";
import { isSelfHosted } from "@/lib/self-hosted";
import { parseIntegrationSetupStatus } from "@/lib/integration-setup";

const ALLOWED_GITHUB_ERRORS = GITHUB_INSTALL_ERROR_CODES;

type GitHubErrorCode = GitHubInstallErrorCode;

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawError = typeof params.error === "string" ? params.error : null;
  const githubError: GitHubErrorCode | null =
    rawError && (ALLOWED_GITHUB_ERRORS as readonly string[]).includes(rawError)
      ? (rawError as GitHubErrorCode)
      : null;
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  if (!session) redirect("/login");

  const cookieStore = await cookies();
  const currentOrgId = cookieStore.get("current_org_id")?.value;

  const member = await prisma.organizationMember.findFirst({
    where: {
      userId: session.user.id,
      ...(currentOrgId ? { organizationId: currentOrgId } : {}),
      deletedAt: null,
      organization: { deletedAt: null, bannedAt: null },
    },
    select: { organizationId: true, role: true },
  });

  if (!member) redirect("/dashboard");

  const orgId = member.organizationId;
  const canManage = hasOrgPermission(member, "integrations:manage");

  const [
    slackIntegration,
    bitbucketIntegration,
    gitlabIntegration,
    githubData,
    ,
    linearIntegration,
    jiraIntegration,
    forgejoIntegration,
  ] = await Promise.all([
    prisma.slackIntegration.findUnique({
      where: { organizationId: orgId },
      select: {
        teamName: true,
        channelId: true,
        channelName: true,
        eventConfigs: {
          select: { eventType: true, enabled: true },
        },
      },
    }),
    prisma.bitbucketIntegration.findUnique({
      where: { organizationId: orgId },
      select: {
        workspaceName: true,
        workspaceSlug: true,
        setupStatus: true,
      },
    }),
    prisma.gitlabIntegration.findUnique({
      where: { organizationId: orgId },
      select: {
        namespaceName: true,
        namespacePath: true,
        gitlabHost: true,
        setupStatus: true,
      },
    }),
    prisma.organization
      .findUnique({
        where: { id: orgId },
        select: { githubInstallationId: true, githubSetupStatus: true },
      })
      .then(async (org) => {
        if (!org?.githubInstallationId) return null;
        const repoCount = await prisma.repository.count({
          where: { organizationId: orgId, provider: "github", isActive: true },
        });
        return { repoCount, setupStatus: parseIntegrationSetupStatus(org.githubSetupStatus) };
      }),
    prisma.collabIntegration.findUnique({
      where: { organizationId: orgId },
      select: {
        baseUrl: true,
        isActive: true,
        workspaceName: true,
      },
    }),
    prisma.linearIntegration
      .findUnique({ where: { organizationId: orgId }, select: { workspaceName: true } })
      .catch(() => null),
    prisma.jiraIntegration
      .findUnique({ where: { organizationId: orgId }, select: { siteName: true } })
      .catch(() => null),
    prisma.forgejoIntegration.findUnique({
      where: { organizationId: orgId },
      select: { id: true, forgejoHost: true, username: true, connectorTokenHash: true, connectorLastSeenAt: true, connectorError: true, setupStatus: true, ...(canManage ? { webhookSecret: true } : {}) },
    }),
  ]);

  // DB-first so the card flips to "Install" after a manifest-created app whose
  // NEXT_PUBLIC_* slug isn't baked into this build.
  const appSlug = (await getGithubAppConfig())?.slug ?? null;
  const selfHosted = isSelfHosted();

  return (
    <div key={orgId} className="space-y-6">
      <IntegrationOAuthErrorBanner error={rawError} />
      <GitHubIntegrationCard
        data={githubData}
        appSlug={appSlug}
        isSelfHosted={selfHosted}
        error={githubError}
        canManage={canManage}
      />
      <BitbucketIntegrationCard data={bitbucketIntegration ? { ...bitbucketIntegration, setupStatus: parseIntegrationSetupStatus(bitbucketIntegration.setupStatus) } : null} canManage={canManage} />
      <GitlabIntegrationCard
        data={gitlabIntegration ? { ...gitlabIntegration, setupStatus: parseIntegrationSetupStatus(gitlabIntegration.setupStatus) } : null}
        redirectUri={process.env.GITLAB_REDIRECT_URI ?? null}
        canManage={canManage}
      />
      <ForgejoIntegrationCard data={forgejoIntegration ? {
        id: forgejoIntegration.id, forgejoHost: forgejoIntegration.forgejoHost,
        username: forgejoIntegration.username,
        ...(canManage ? { webhookSecret: forgejoIntegration.webhookSecret } : {}),
        connectionMode: forgejoIntegration.connectorTokenHash ? "connector" : "direct",
        connectorLastSeenAt: forgejoIntegration.connectorLastSeenAt?.toISOString() ?? null,
        connectorError: forgejoIntegration.connectorError,
        setupStatus: parseIntegrationSetupStatus(forgejoIntegration.setupStatus),
      } : null} canManage={canManage} selfHosted={selfHosted} appUrl={process.env.BETTER_AUTH_URL ?? null} />
      <SlackIntegrationCard data={slackIntegration} />
      <LinearIntegrationCard data={linearIntegration} />
      <JiraIntegrationCard data={jiraIntegration} />
    </div>
  );
}
