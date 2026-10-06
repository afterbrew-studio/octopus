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

// Upstream failures must preserve an existing connection and keep credentials out of logs.
const callbackUrl = new URL(`https://octopus.example.test/api/gitlab/callback?code=fixture&state=${Buffer.from(JSON.stringify({ nonce: "nonce" })).toString("base64url")}`);
const callbackRequest = Object.assign(new Request(callbackUrl), { nextUrl: callbackUrl }) as never;
const goodTokens = { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 };
const originalError = console.error;
const logged: unknown[][] = [];
console.error = (...args: unknown[]) => { logged.push(args); };
try {
  for (const stage of ["token", "group", "user"] as const) {
    for (const failure of ["network", "timeout", "html", "null", "shape", "missing", "oversized", "rejected", "empty"] as const) {
      let calls = 0;
      existing = { ...original };
      const writesBefore = writes.length;
      const syncsBefore = syncCalls.length;
      globalThis.fetch = (async (input: string | URL | Request, options?: RequestInit) => {
        calls++;
        const url = String(input);
        const currentStage = url.endsWith("/oauth/token") ? "token" : url.includes("/groups/") ? "group" : "user";
        if (stage === "user" && currentStage === "group") return new Response(null, { status: 404 });
        if (currentStage !== stage) return Response.json(currentStage === "token" ? goodTokens : { name: "Group" });
        if (failure === "network") throw new TypeError("fixture-access private-response");
        if (failure === "timeout") throw new DOMException("fixture-secret", "TimeoutError");
        // The real request must carry a deadline and must not forward credentials through redirects.
        assert.ok(options?.signal instanceof AbortSignal);
        assert.equal(options?.redirect, "error");
        if (failure === "html") return new Response("<html>private-response fixture-access</html>");
        if (failure === "null") return Response.json(null);
        if (failure === "missing") return Response.json(stage === "user" ? [{}] : {});
        if (failure === "oversized") return new Response("x".repeat(1024 * 1024 + 1));
        if (failure === "shape") return Response.json(stage === "token" ? { ...goodTokens, expires_in: "bad" } : stage === "group" ? [] : {});
        if (failure === "empty") return stage === "user" ? Response.json([]) : new Response("");
        return Response.json({ error: "denied", private: "fixture-access" }, { status: 403 });
      }) as typeof fetch;
      const response = await gitlab(callbackRequest);
      assert.equal(response.status, 307);
      const location = new URL(response.headers.get("location")!);
      assert.equal(location.searchParams.get("error"), stage === "token" ? "token_exchange" : "namespace_not_found", `${stage}: ${failure}`);
      assert.equal(writes.length, writesBefore);
      assert.equal(syncCalls.length, syncsBefore);
      assert.equal(calls, stage === "token" ? 1 : stage === "group" ? 2 : 3, "authorization code exchange is never blindly retried");
      assert.deepEqual(existing, original);
    }
  }
  assert.doesNotMatch(JSON.stringify(logged), /fixture-access|fixture-secret|private-response|gitlab\.example/);
  throwSync = false;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return Response.json(goodTokens);
    if (url.includes("/groups/")) return new Response(null, { status: 404 });
    return Response.json([{ name: "Personal namespace" }]);
  }) as typeof fetch;
  const personal = await gitlab(callbackRequest);
  assert.equal(new URL(personal.headers.get("location")!).searchParams.get("authorized"), "gitlab");
  assert.equal(writes.at(-1)?.update.namespaceName, "Personal namespace");
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("must not fetch for invalid state"); }) as typeof fetch;
  const invalidUrl = new URL(callbackUrl);
  invalidUrl.searchParams.set("state", Buffer.from(JSON.stringify({ nonce: "wrong" })).toString("base64url"));
  const invalid = await gitlab(Object.assign(new Request(invalidUrl), { nextUrl: invalidUrl }) as never);
  assert.equal(new URL(invalid.headers.get("location")!).searchParams.get("error"), "state_mismatch");
  assert.equal(fetches, 0);
} finally {
  console.error = originalError;
}
console.log("GitLab callback failure checks: passed");
