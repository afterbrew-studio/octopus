import "server-only";
import { prisma } from "@octopus/db";
import { authenticateApiToken } from "@/lib/api-auth";
import { getGithubAppConfig } from "@/lib/github-app-config";
import { getInstallationSettingsUrl, listInstallationRepos } from "@/lib/github";
import { applyRepositoryEvent } from "@/lib/repo-sync";
import { connectCliRepository, parseConnectRepository } from "@/lib/cli-repo-connect";

export async function POST(request: Request) {
  const identity = await authenticateApiToken(request);
  if (identity instanceof Response) return identity;
  if (!identity) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const member = await prisma.organizationMember.findFirst({
    where: { organizationId: identity.org.id, userId: identity.user.id, deletedAt: null },
    select: { id: true },
  });
  if (!member) return Response.json({ error: "Organisation membership required" }, { status: 403 });
  const fullName = parseConnectRepository(await request.json().catch(() => null));
  if (!fullName) return Response.json({ error: "Expected only fullName: GitHub owner/repository" }, { status: 400 });

  try {
    const result = await connectCliRepository({
      fullName, organizationId: identity.org.id,
      installationId: identity.org.githubInstallationId,
      baseUrl: process.env.BETTER_AUTH_URL || new URL(request.url).origin,
    }, {
      find: () => prisma.repository.findFirst({
        where: { organizationId: identity.org.id, provider: "github", fullName: { equals: fullName, mode: "insensitive" } },
        // Repository names are not unique: an inactive historical row may share
        // the live repo's name after a transfer or recreation on GitHub.
        orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
        select: { id: true, isActive: true, dismissedAt: true, installationId: true },
      }),
      appConfigured: async () => Boolean((await getGithubAppConfig())?.slug),
      settingsUrl: getInstallationSettingsUrl,
      list: listInstallationRepos,
      sync: async (installationId, repo) => {
        await applyRepositoryEvent(identity.org.id, installationId, "created", repo);
      },
    });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    // Provider responses may contain private installation details. Keep them out of CLI output.
    return Response.json({ error: "Could not verify GitHub access or sync the repository. Check the integration and retry." }, { status: 503 });
  }
}
