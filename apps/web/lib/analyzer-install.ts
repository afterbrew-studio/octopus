/**
 * Resolve the GitHub App installation the package analyzer should use.
 *
 * The analyzer historically used only the *current org's* stored
 * `githubInstallationId`, which can be stale/null (a webhook nulls it and
 * nothing always re-populates it) — so private-repo analyses silently fell back
 * to unauthenticated and 404'd. Reviews never hit this because they resolve the
 * token from the *repository's own* `installationId` (see reviewer.ts). This
 * mirrors that: when a known repository is being analyzed, prefer its live
 * per-repo installation, but only after confirming the caller is authorized for
 * that repo's org (so a repositoryId can't reach another tenant's install).
 */

type InstallResolverClient = {
  repository: {
    findUnique(args: {
      where: { id: string };
      select: { installationId: true; organizationId: true };
    }): Promise<{ installationId: number | null; organizationId: string } | null>;
  };
  organizationMember: {
    findFirst(args: {
      where: { userId: string; organizationId: string; deletedAt: null };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

export async function resolveAnalyzerInstallation(
  client: InstallResolverClient,
  opts: {
    repositoryId?: string | null;
    callerOrgId: string;
    callerUserId: string;
    fallbackInstallationId: number | null;
  },
): Promise<number | null> {
  const { repositoryId, callerOrgId, callerUserId, fallbackInstallationId } = opts;
  if (!repositoryId) return fallbackInstallationId;

  const repo = await client.repository.findUnique({
    where: { id: repositoryId },
    select: { installationId: true, organizationId: true },
  });
  if (!repo) return fallbackInstallationId;

  // Tenancy: only use the repo's own installation if the caller belongs to the
  // repo's org (the caller's current org, or any org they're a member of).
  const authorized =
    repo.organizationId === callerOrgId ||
    (await client.organizationMember.findFirst({
      where: { userId: callerUserId, organizationId: repo.organizationId, deletedAt: null },
      select: { id: true },
    })) !== null;
  if (!authorized) return fallbackInstallationId;

  return repo.installationId ?? fallbackInstallationId;
}
