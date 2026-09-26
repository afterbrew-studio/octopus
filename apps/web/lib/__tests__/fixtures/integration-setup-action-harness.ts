import assert from "node:assert/strict";
import { mock } from "bun:test";

mock.module("server-only", () => ({}));
let signedIn = true;
let orgId: string | null = "org_current";
let role: string | null = null;
let connected = true;
let syncError = "";
let unexpectedFailure = false;
const calls: unknown[] = [];
const revalidated: string[] = [];
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => orgId ? { value: orgId } : undefined }) }));
mock.module("next/navigation", () => ({ redirect: () => { throw new Error("login redirect"); } }));
mock.module("next/cache", () => ({ revalidatePath: (path: string) => revalidated.push(path) }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user: { id: "user_1" } } : null } } }));
const findIntegration = async ({ where }: { where: { organizationId: string } }) => {
  assert.equal(where.organizationId, "org_current");
  return connected ? { id: "integration_1", webhookSecret: "stored-signing-secret", webhookUuid: "saved-hook-id" } : null;
};
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async ({ where }: { where: Record<string, unknown> }) => {
    assert.equal(where.userId, "user_1");
    assert.equal(where.organizationId, "org_current");
    assert.deepEqual(where.organization, { deletedAt: null, bannedAt: null });
    assert.equal(where.deletedAt, null);
    return role ? { role, organizationId: "org_current" } : null;
  } },
  organization: { findUnique: async ({ where }: { where: { id: string } }) => {
    assert.equal(where.id, "org_current");
    return { githubInstallationId: connected ? 17 : null };
  } },
  bitbucketIntegration: { findUnique: findIntegration },
  gitlabIntegration: { findUnique: findIntegration },
  forgejoIntegration: { findUnique: findIntegration },
} }));
mock.module("@/lib/repo-sync", () => ({
  syncForgejoRepos: async () => ({ synced: 0, error: "Forgejo is unreachable. Check the connector." }),
  syncOrgRepos: async (id: string, opts: unknown) => {
    calls.push({ id, opts });
    if (unexpectedFailure) throw new Error("raw provider credential details");
    return { synced: 3, error: syncError };
  },
}));
mock.module("@/lib/forgejo", () => ({ validateForgejoConnection() {} }));
const { retryIntegrationSetup, syncForgejo, getIntegrationWebhookDetails } = await import("@/app/(app)/settings/integrations/actions");

signedIn = false;
await assert.rejects(() => retryIntegrationSetup("bitbucket"), /login redirect/);
signedIn = true;
orgId = null;
assert.equal((await retryIntegrationSetup("bitbucket")).error, "Insufficient permissions.");
orgId = "org_current";
for (const memberRole of [null, "member", "viewer"]) {
  role = memberRole;
  assert.equal((await retryIntegrationSetup("bitbucket")).error, "Insufficient permissions.");
  assert.deepEqual(await getIntegrationWebhookDetails("gitlab"), { error: "Insufficient permissions." });
}
assert.equal(calls.length, 0);
role = "owner";
assert.equal((await retryIntegrationSetup("slack" as "bitbucket")).error, "Choose a supported code provider.");
connected = false;
assert.equal((await retryIntegrationSetup("gitlab")).error, "Connect this provider before checking setup.");
assert.equal(calls.length, 0);
connected = true;
for (const provider of ["bitbucket", "gitlab", "github", "forgejo"] as const) {
  assert.equal((await retryIntegrationSetup(provider)).synced, 3);
  assert.deepEqual(calls.at(-1), { id: "org_current", opts: { source: "manual", providers: [provider] } });
}
role = "admin";
syncError = "Repositories synced, but webhook setup needs attention.";
assert.deepEqual(await retryIntegrationSetup("gitlab"), { synced: 3, error: syncError });
unexpectedFailure = true;
const failure = await retryIntegrationSetup("bitbucket");
assert.match(failure.error!, /authorization has been kept/);
assert.ok(!failure.error!.includes("credential details"));
assert.match((await syncForgejo()).error!, /Check the connector/);
for (const path of ["/settings/integrations", "/repositories", "/dashboard"]) assert.ok(revalidated.includes(path));

process.env.BETTER_AUTH_URL = "https://octopus.example";
const syncCount = calls.length;
assert.deepEqual(await getIntegrationWebhookDetails("bitbucket"), { details: {
  url: "https://octopus.example/api/bitbucket/webhook", secret: "stored-signing-secret",
  description: "Octopus Review (org_current) [integration_1]", hookId: "saved-hook-id",
} });
assert.deepEqual(await getIntegrationWebhookDetails("gitlab"), { details: {
  url: "https://octopus.example/api/gitlab/webhook?octopus_org=org_current&octopus_connection=integration_1", secret: "stored-signing-secret",
} });
assert.equal(calls.length, syncCount, "Reading recovery details must not sync or change provider hooks");
assert.deepEqual(await getIntegrationWebhookDetails("github" as "gitlab"), { error: "Choose Bitbucket or GitLab." });
connected = false;
assert.equal((await getIntegrationWebhookDetails("gitlab")).details, undefined);
delete process.env.BETTER_AUTH_URL;
assert.match((await getIntegrationWebhookDetails("bitbucket")).error!, /application URL is not configured/);
