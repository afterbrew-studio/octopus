import { mock } from "bun:test";
import assert from "node:assert/strict";

process.env.BETTER_AUTH_URL = "https://octopus.example.test";
process.env.BITBUCKET_CLIENT_ID = "fixture-id";
process.env.BITBUCKET_CLIENT_SECRET = "fixture-secret";
process.env.BITBUCKET_REDIRECT_URI = "https://octopus.example.test/api/bitbucket/callback";
process.env.GITLAB_CLIENT_SECRET = "fixture-secret";
process.env.GITLAB_REDIRECT_URI = "https://octopus.example.test/api/gitlab/callback";
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: "fixture-cookie" }), delete: () => {} }) }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user" } }) } } }));
mock.module("@/lib/integration-oauth-state", () => ({ integrationOAuthStateCookie: () => "fixture", verifyIntegrationOAuthState: () => ({ ok: true, state: { orgId: "org", userId: "user", context: { workspaceSlug: "workspace" } } }) }));
mock.module("@/lib/crypto", () => ({ encryptString: (value: string) => `encrypted:${value}`, decryptJson: () => ({
  nonce: "nonce", orgId: "org", namespacePath: "group", gitlabHost: "https://gitlab.example.test", clientId: "fixture", clientSecret: null, issuedAt: Date.now(),
}) }));
const original = { id: "generation1", webhookSecret: "existing-webhook-secret", webhookUuid: "existing-hook", workspaceSlug: "workspace", gitlabHost: "https://gitlab.example.test", namespacePath: "group" };
let existing: typeof original | null = { ...original };
let role = "owner";
const writes: Array<{ create: Record<string, unknown>; update: Record<string, unknown> }> = [];
const integration = { findUnique: async () => existing, upsert: async (args: typeof writes[number]) => { writes.push(args); return {}; } };
const resets: unknown[] = [];
const db = { organizationMember: { findFirst: async () => ({ role }) }, bitbucketIntegration: integration, gitlabIntegration: integration,
  repository: { updateMany: async (args: unknown) => { resets.push(args); } }, $queryRaw: async () => [{ acquired: true }] };
mock.module("@octopus/db", () => ({ prisma: { ...db, $transaction: async (run: (tx: typeof db) => Promise<unknown>) => run(db) } }));
let syncError: string | null = null;
let throwSync = false;
const syncCalls: Array<{ source: string; providers: string[] }> = [];
mock.module("@/lib/repo-sync", () => ({ syncOrgRepos: async (_org: string, options: typeof syncCalls[number]) => {
  syncCalls.push(options);
  if (throwSync) throw new Error("private setup error");
  return { synced: 1, error: syncError };
} }));
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url === "https://bitbucket.org/site/oauth2/access_token" || url === "https://gitlab.example.test/oauth/token") {
    return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 });
  }
  assert(["https://api.bitbucket.org/2.0/workspaces/workspace", "https://gitlab.example.test/api/v4/groups/group"].includes(url));
  return Response.json({ name: "Fixture scope" });
}) as typeof fetch;
const { GET: bitbucket } = await import("../../../app/api/bitbucket/callback/route");
const { GET: gitlab } = await import("../../../app/api/gitlab/callback/route");
for (const [provider, callback] of [["bitbucket", bitbucket], ["gitlab", gitlab]] as const) {
  existing = { ...original };
  const state = Buffer.from(JSON.stringify({ nonce: "nonce" })).toString("base64url");
  const url = new URL(`https://octopus.example.test/api/${provider}/callback?code=fixture&state=${state}`);
  const request = Object.assign(new Request(url), { nextUrl: url }) as never;
  syncError = "Setup needs attention";
  throwSync = false;
  const failed = new URL((await callback(request)).headers.get("location")!);
  assert.equal(failed.searchParams.get("authorized"), provider);
  assert.equal(failed.searchParams.get("setup"), "attention");
  assert.equal(failed.searchParams.get("success"), null);
  assert.equal(failed.searchParams.get("bb_debug"), null);
  assert.equal(failed.searchParams.get("gl_debug"), null);
  assert.equal(writes.at(-1)?.update.webhookSecret, "existing-webhook-secret", "reauthorization must preserve existing webhook secrets");
  assert.deepEqual(syncCalls.at(-1), { source: "manual", providers: [provider] });
  if (provider === "bitbucket") assert.equal(writes.at(-1)?.update.webhookUuid, "existing-hook");
  syncError = null;
  const ready = new URL((await callback(request)).headers.get("location")!);
  assert.equal(ready.searchParams.get("authorized"), provider);
  assert.equal(ready.searchParams.get("setup"), null);
  throwSync = true;
  const rejected = new URL((await callback(request)).headers.get("location")!);
  assert.equal(rejected.searchParams.get("setup"), "attention");
  assert(!rejected.toString().includes("private setup error"));
  for (const replacement of [{ gitlabHost: "https://other.test", workspaceSlug: "other" }, { namespacePath: "other", workspaceSlug: "other" }]) {
    existing = { ...original, ...replacement };
    const count = writes.length;
    const rejectedBinding = new URL((await callback(request)).headers.get("location")!);
    assert.equal(rejectedBinding.searchParams.get("error"), "connection_replacement");
    assert.equal(writes.length, count);
  }
  existing = null;
  await callback(request);
  assert.notEqual(writes.at(-1)?.create.webhookSecret, original.webhookSecret);
  assert.deepEqual(resets.at(-1), { where: { organizationId: "org", provider }, data: { webhookSetupStatus: { status: "unknown" }, isActive: false } });
  existing = { ...original };
  const writeCount = writes.length;
  role = "member";
  await callback(request);
  assert.equal(writes.length, writeCount, "non-admin callback cannot change an integration");
  role = "owner";
}
existing = null;
console.log("OAuth callback setup: passed");
