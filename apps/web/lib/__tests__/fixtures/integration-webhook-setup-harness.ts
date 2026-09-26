import { mock } from "bun:test";
import assert from "node:assert/strict";

mock.module("server-only", () => ({}));
const originalIntegration = { id: "integration", accessToken: "fixture-token", refreshToken: "fixture-refresh", tokenExpiresAt: new Date(Date.now() + 3_600_000), gitlabHost: "https://gitlab.example.test", namespacePath: "group", workspaceSlug: "workspace", webhookSecret: "fixture-secret" };
let integration: typeof originalIntegration | null = { ...originalIntegration };
const locks = new Set<string>();
let denyLock = false;
const db = {
  bitbucketIntegration: { findUnique: async () => integration, deleteMany: async () => { integration = null; }, upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    integration = integration ? { ...integration, ...update } : { ...originalIntegration, ...create, id: "new-generation" };
  } },
  gitlabIntegration: { findUnique: async () => integration, deleteMany: async () => { integration = null; }, upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    integration = integration ? { ...integration, ...update } : { ...originalIntegration, ...create, id: "new-generation" };
  } },
  repository: { updateMany: async () => ({ count: 1 }) },
  organizationMember: { findFirst: async () => ({ role: "owner", organizationId: "org_fixture" }) },
};
mock.module("@octopus/db", () => ({ prisma: { ...db,
  $transaction: async (run: (tx: unknown) => Promise<unknown>) => {
    const acquiredKeys: string[] = [];
    try {
      return await run({ ...db, $queryRaw: async (_sql: TemplateStringsArray, key: string) => {
        const acquired = !denyLock && (!locks.has(key) || acquiredKeys.includes(key));
        if (acquired) { locks.add(key); acquiredKeys.push(key); }
        return [{ acquired }];
      } });
    } finally { for (const key of acquiredKeys) locks.delete(key); }
  },
} }));
process.env.BETTER_AUTH_URL = "https://octopus.example.test";
process.env.BITBUCKET_CLIENT_ID = "fixture-id";
process.env.BITBUCKET_CLIENT_SECRET = "fixture-secret";
process.env.BITBUCKET_REDIRECT_URI = "https://octopus.example.test/api/bitbucket/callback";
process.env.GITLAB_CLIENT_SECRET = "fixture-secret";
process.env.GITLAB_REDIRECT_URI = "https://octopus.example.test/api/gitlab/callback";
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: "fixture-cookie" }), delete() {} }) }));
mock.module("next/navigation", () => ({ redirect: () => { throw new Error("unexpected redirect"); } }));
mock.module("next/cache", () => ({ revalidatePath() {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user" } }) } } }));
mock.module("@/lib/integration-oauth-state", () => ({ integrationOAuthStateCookie: () => "fixture", verifyIntegrationOAuthState: () => ({ ok: true, state: { orgId: "org_fixture", userId: "user", context: { workspaceSlug: "workspace" } } }) }));
mock.module("@/lib/crypto", () => ({ encryptJson: (value: unknown) => JSON.stringify(value), decryptStringMaybeLegacy: (v: string) => v, decryptString: (v: string) => v, encryptString: (v: string) => v, decryptJson: () => ({
  nonce: "nonce", orgId: "org_fixture", namespacePath: "group", gitlabHost: "https://gitlab.example.test", clientId: "fixture", clientSecret: null, issuedAt: Date.now(),
}) }));
mock.module("@/lib/repo-sync", () => ({ syncOrgRepos: async () => ({ synced: 0 }), syncForgejoRepos: async () => ({ synced: 0 }) }));
mock.module("@/lib/forgejo", () => ({ validateForgejoConnection() {} }));
const { disconnectGitlab, disconnectBitbucket, getIntegrationWebhookDetails } = await import("../../../app/(app)/settings/integrations/actions");
const { GET: gitlabCallback } = await import("../../../app/api/gitlab/callback/route");
const { GET: bitbucketCallback } = await import("../../../app/api/bitbucket/callback/route");

const { createWebhook } = await import("../../bitbucket");
const { createProjectWebhook } = await import("../../gitlab");
type Hook = Record<string, unknown>;
for (const provider of ["bitbucket", "gitlab"] as const) {
  const callback = `https://octopus.example.test/api/${provider}/webhook`;
  const ownedUrl = `${callback}?octopus_org=org_fixture&octopus_connection=integration`;
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  let hooks: Hook[] = [];
  let failList = false;
  let failCreate = false;
  let paginated = false;
  let reconnectDuringList = false;
  const foreign = provider === "bitbucket"
    ? { uuid: "foreign", url: "https://unrelated.example.test/hook", description: "Keep me", active: true, events: ["repo:push"] }
    : { id: 2, url: "https://unrelated.example.test/hook", note_events: false };
  const known = provider === "bitbucket"
    ? { uuid: "hook1", url: callback, description: "Octopus Review (org_fixture) [integration]", active: true, secret_set: true, events: ["pullrequest:created", "pullrequest:updated", "pullrequest:comment_created"] }
    : { id: 1, url: ownedUrl, note_events: true, merge_requests_events: true, enable_ssl_verification: true, token_present: true, alert_status: "executable", disabled_until: null };
  let onPost: (() => Promise<void>) | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/oauth/token") || url.endsWith("/site/oauth2/access_token")) return Response.json({ access_token: "fixture-token", refresh_token: "fixture-refresh", expires_in: 3600 });
    if (url.endsWith("/workspaces/workspace") || url.endsWith("/groups/group")) return Response.json({ name: "Fixture" });
    assert(url.startsWith(provider === "bitbucket" ? "https://api.bitbucket.org/2.0/workspaces/" : "https://gitlab.example.test/api/v4/projects/"));
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    if (method === "GET") {
      if (reconnectDuringList) integration = { ...originalIntegration, gitlabHost: "https://replacement.example.test", namespacePath: "replacement", workspaceSlug: "replacement", accessToken: "replacement-token" };
      if (failList) return new Response("sensitive provider response", { status: 403 });
      const page2 = new URL(url).searchParams.get("page") === "2";
      const values = paginated && !page2 ? [foreign] : hooks;
      if (provider === "bitbucket") return Response.json({ values, ...(paginated && !page2 ? { next: "https://untrusted.example.test/no-token" } : {}) });
      return Response.json(values, { headers: paginated && !page2 ? { "x-next-page": "2" } : {} });
    }
    assert.equal(method, "POST", "Setup must not modify or delete any existing hook");
    if (onPost) await onPost();
    if (failCreate) return new Response("secret-bearing create response", { status: 403 });
    assert.equal(provider === "bitbucket" ? body.secret : body.token, "fixture-secret");
    assert.equal(body.url, provider === "bitbucket" ? callback : ownedUrl);
    hooks.push({ ...known });
    return Response.json(known, { status: 201 });
  }) as typeof fetch;
  const setup = () => provider === "bitbucket"
    ? createWebhook("org_fixture", "workspace", callback, "fixture-secret", originalIntegration)
    : createProjectWebhook("org_fixture", "group/project", callback, "fixture-secret", originalIntegration);

  integration = { ...originalIntegration, gitlabHost: "https://replacement.example.test", namespacePath: "replacement", workspaceSlug: "replacement", accessToken: "replacement-token" };
  await assert.rejects(setup(), /connection changed/);
  assert.equal(calls.length, 0, "A reconnected binding must not receive an old project's request or webhook secret");
  integration = { ...originalIntegration };
  reconnectDuringList = true;
  await assert.rejects(setup(), /connection changed/);
  assert(calls.every(c => c.method === "GET"), "Reconnect during hook listing must prevent creation");
  reconnectDuringList = false;
  integration = { ...originalIntegration };
  calls.length = 0;

  failList = true;
  await assert.rejects(setup(), /Could not check/);
  assert(!calls.some(c => c.method === "POST"));
  failList = false;
  failCreate = true;
  await assert.rejects(setup(), /Could not create/);
  failCreate = false;
  calls.length = 0;
  hooks = [{ ...foreign }];
  await setup();
  await setup();
  assert.equal(calls.filter(c => c.method === "POST").length, 1, "Repair followed by retry must not duplicate hooks");
  assert.deepEqual(hooks[0], foreign, "Unrelated hooks stay unchanged");

  calls.length = 0;
  paginated = true;
  await setup();
  assert.equal(calls.length, 2);
  assert(calls.every(c => c.method === "GET"));
  paginated = false;

  calls.length = 0;
  hooks = [{ ...known, ...(provider === "bitbucket" ? { description: "Octopus Review" } : { url: callback }) }];
  await assert.rejects(setup(), /no saved ownership evidence/);
  assert(!calls.some(c => c.method === "POST"));

  hooks = [{ ...known, ...(provider === "bitbucket" ? { active: false } : { alert_status: "permanently_disabled" }) }];
  await assert.rejects(setup(), /needs attention/);
  assert(!calls.some(c => c.method === "POST"));

  calls.length = 0;
  denyLock = true;
  await assert.rejects(setup(), /already running/);
  assert.equal(calls.length, 0);
  denyLock = false;

  hooks = [];
  calls.length = 0;
  const disconnect = provider === "gitlab" ? disconnectGitlab : disconnectBitbucket;
  const reconnect = provider === "gitlab" ? gitlabCallback : bitbucketCallback;
  const state = Buffer.from(JSON.stringify({ nonce: "nonce" })).toString("base64url");
  const requestUrl = new URL(`https://octopus.example.test/api/${provider}/callback?code=fixture&state=${state}`);
  const request = Object.assign(new Request(requestUrl), { nextUrl: requestUrl }) as never;
  let releasePost!: () => void;
  let enteredPost!: () => void;
  const posted = new Promise<void>(resolve => { enteredPost = resolve; });
  const paused = new Promise<void>(resolve => { releasePost = resolve; });
  onPost = async () => { enteredPost(); await paused; };
  const pendingSetup = setup();
  await posted;
  assert.match((await disconnect()).error!, /Retry shortly/);
  const busy = new URL((await reconnect(request)).headers.get("location")!);
  assert.equal(busy.searchParams.get("error"), "connection_busy");
  assert.equal(integration?.id, originalIntegration.id);
  releasePost();
  await pendingSetup;
  onPost = undefined;
  assert.deepEqual(await disconnect(), {});
  assert.equal(integration, null);
  assert.equal(hooks.length, 1, "Disconnect retains the remote hook");
  await reconnect(request);
  const current = await db.gitlabIntegration.findUnique();
  assert.ok(current);
  assert.notEqual(current.webhookSecret, originalIntegration.webhookSecret);
  const setupCurrent = () => provider === "gitlab"
    ? createProjectWebhook("org_fixture", "group/project", callback, current.webhookSecret, current)
    : createWebhook("org_fixture", "workspace", callback, current.webhookSecret, current);
  const before = JSON.stringify(hooks);
  calls.length = 0;
  await assert.rejects(setupCurrent(), /no saved ownership evidence/);
  assert.equal(JSON.stringify(hooks), before);
  assert(calls.every(call => call.method === "GET"));
  const repair = (await getIntegrationWebhookDetails(provider)).details!;
  assert.equal(repair.secret, current.webhookSecret);
  hooks[0] = { ...known, url: repair.url, ...(provider === "bitbucket" ? { description: repair.description } : {}) };
  await setupCurrent();
  assert(calls.every(call => call.method === "GET"), "Explicit repair reuses the retained hook without duplicate creation");
  integration = { ...originalIntegration };
}
console.log("provider webhook setup: passed");
