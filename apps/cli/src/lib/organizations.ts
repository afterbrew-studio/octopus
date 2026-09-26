import { getJson, postJson, normalizeBaseUrl, isTransportSafe } from "./api.js";
import type { Credentials } from "./credentials.js";

export interface OrganizationChoice {
  id: string;
  slug: string;
  name: string;
  matchesRepository?: boolean;
  matchesOwner?: boolean;
  hasInstallation?: boolean;
}
let organizationOverride: string | undefined;
export function setOrganizationOverride(value: string): void { organizationOverride = value; }
export function getOrganizationOverride(): string | undefined { return organizationOverride; }

export function chooseOrganization(choices: OrganizationChoice[], explicit?: string, repo?: string, requireRepositoryMatch = false): OrganizationChoice | undefined {
  if (explicit) return choices.find((org) => org.id === explicit || org.slug === explicit);
  const exact = choices.filter((org) => org.matchesRepository);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const owners = choices.filter((org) => org.matchesOwner);
  if (owners.length) return owners.length === 1 ? owners[0] : undefined;
  if (!requireRepositoryMatch && choices.length === 1 && (!repo || !choices[0].hasInstallation)) return choices[0];
  return undefined;
}

export async function listOrganizations(creds: Credentials, repo?: string) {
  const base = normalizeBaseUrl(creds.baseUrl);
  if (!base || base !== creds.baseUrl || !isTransportSafe(base)) return { ok: false as const, status: 0, error: "Unsafe server URL in saved credentials." };
  const response = await getJson<{ organizations: OrganizationChoice[] }>(`${base}/api/cli/organizations${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`, { headers: { authorization: `Bearer ${creds.token}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return response;
  const rows = response.data?.organizations;
  if (!Array.isArray(rows) || rows.some((org) => !org || typeof org.id !== "string" || typeof org.slug !== "string" || typeof org.name !== "string" || [org.matchesRepository, org.matchesOwner, org.hasInstallation].some((value) => value !== undefined && typeof value !== "boolean"))) return { ok: false as const, status: 0, error: "Invalid organization response." };
  return { ok: true as const, organizations: rows };
}

export async function resolveOrganization(creds: Credentials, explicit?: string, repo?: string, requireRepositoryMatch = false): Promise<
  { ok: true; credentials: Credentials; userSession: boolean } |
  { ok: false; state: "organization_required" | "authentication_required" | "failed"; message: string; organizations?: OrganizationChoice[] }
> {
  if (creds.kind !== "user") {
    if (explicit && explicit !== creds.orgId && explicit !== creds.orgSlug) return { ok: false, state: "authentication_required", message: "This saved token is bound to another organisation. Run octp login once to enable --org switching." };
    return { ok: true, credentials: creds, userSession: false };
  }
  const response = await listOrganizations(creds, repo);
  if (!response.ok) return { ok: false, state: response.status === 401 ? "authentication_required" : "failed", message: `Could not list organisations: ${response.error}` };
  const choice = chooseOrganization(response.organizations, explicit, repo, requireRepositoryMatch);
  if (!choice) return {
    ok: false, state: "organization_required", organizations: response.organizations.map(({ id, slug, name }) => ({ id, slug, name })),
    message: explicit ? "The requested organisation is not available to this user. Select an available --org slug." : response.organizations.length ? "Select an organisation with --org <slug>, then retry. No work has started." : "No organisations are available. Create or join one in Octopus, then retry.",
  };
  const scoped = await postJson<{ token: string; organization: { id: string; slug: string; name: string } }>(`${creds.baseUrl}/api/cli/organizations`, { organization: choice.id }, creds.token, { timeoutMs: 15_000 });
  if (!scoped.ok) return { ok: false, state: scoped.status === 401 ? "authentication_required" : "failed", message: `Could not select organisation: ${scoped.error}` };
  if (!scoped.data || !/^oct_[a-f0-9]{64}$/.test(scoped.data.token) || scoped.data.organization?.id !== choice.id || scoped.data.organization?.slug !== choice.slug) return { ok: false, state: "failed", message: "Invalid organisation credential response." };
  return { ok: true, userSession: true, credentials: { ...creds, kind: undefined, token: scoped.data.token, orgId: choice.id, orgSlug: choice.slug, orgName: choice.name } };
}
