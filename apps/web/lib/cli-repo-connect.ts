import "server-only";

export function parseConnectRepository(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 1 || typeof object.fullName !== "string") return null;
  const name = object.fullName;
  if (name.length > 140 || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name)) return null;
  if ([".", ".."].includes(name.split("/")[1])) return null;
  return name;
}

interface RepositoryConnectionRow {
  id: string;
  isActive: boolean;
  dismissedAt: Date | null;
  installationId: number | null;
}
interface InstallationRepository {
  id: number;
  name: string;
  full_name: string;
  default_branch: string;
}
export interface ConnectRepositoryServices {
  find: () => Promise<RepositoryConnectionRow | null>;
  appConfigured: () => Promise<boolean>;
  settingsUrl: (id: number) => Promise<string>;
  list: (id: number) => Promise<InstallationRepository[]>;
  sync: (id: number, repo: InstallationRepository) => Promise<void>;
}

/** Resolves access only within the token's bound organisation/installation. */
export async function connectCliRepository(
  input: { fullName: string; organizationId: string; installationId: number | null; baseUrl: string },
  services: ConnectRepositoryServices,
) {
  const existing = await services.find();
  const repositoriesUrl = new URL("/repositories", input.baseUrl).href;
  if (existing?.dismissedAt) return { state: "repository_dismissed" as const, url: repositoriesUrl };
  if (!input.installationId) {
    if (!(await services.appConfigured())) throw new Error("github_app_not_configured");
    const url = new URL("/api/github/install", input.baseUrl);
    url.searchParams.set("orgId", input.organizationId);
    url.searchParams.set("returnTo", "/repositories");
    return { state: "installation_required" as const, url: url.href };
  }
  if (existing?.isActive && existing.installationId === input.installationId) return { state: "connected" as const, repoId: existing.id };

  // Installation-scoped listing proves access; matching a public repo by name alone does not.
  const repos = await services.list(input.installationId);
  const repo = repos.find((r) => r.full_name.toLowerCase() === input.fullName.toLowerCase());
  if (!repo) return { state: "repository_access_required" as const, url: await services.settingsUrl(input.installationId) };
  await services.sync(input.installationId, repo);
  const imported = await services.find();
  if (imported?.dismissedAt) return { state: "repository_dismissed" as const, url: repositoriesUrl };
  if (!imported?.isActive || imported.installationId !== input.installationId) throw new Error("repository_sync_incomplete");
  return { state: "connected" as const, repoId: imported.id };
}
