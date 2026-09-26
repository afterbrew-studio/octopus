import assert from "node:assert/strict";
import { mock } from "bun:test";
import { decryptString } from "@/lib/crypto";

mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: "org_1" }) }) }));
mock.module("next/navigation", () => ({ redirect: () => { throw new Error("redirect"); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => ({ user: { id: "user_1" } }) } } }));

type Integration = { id: string; organizationId: string; forgejoHost: string; username: string; accessTokenEnc: string; webhookSecret: string };
let integration: Integration | null = null;
let member: { role: string; organizationId: string } | null = null;
let username = "review-bot";
let validations = 0;
let syncs = 0;
let repoAvailable = true;
const repository = {
  id: "repo_1", fullName: "team/repo", provider: "forgejo", externalId: "https://forge.example.com:1",
  organizationId: "org_1", indexStatus: "indexed", isActive: false, dismissedAt: new Date(),
  organization: { members: [{ role: "owner" }] },
};
const operations: string[] = [];
const client = {
  organizationMember: { findFirst: async () => member },
  forgejoIntegration: {
    findUnique: async () => integration,
    create: async ({ data }: { data: Omit<Integration, "id"> }) => { operations.push("create"); integration = { id: "connection_1", ...data }; return integration; },
    update: async ({ data }: { data: { accessTokenEnc: string } }) => { operations.push("token"); assert.ok(integration); Object.assign(integration, data); return integration; },
    deleteMany: async () => { operations.push("disconnect"); integration = null; return { count: 1 }; },
  },
  repository: {
    findUnique: async () => ({ ...repository }),
    update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(repository, data); return repository; },
    updateMany: async ({ where, data }: { where: { id?: string; organizationId?: string; provider?: string }; data: { isActive?: boolean; dismissedAt?: Date } }) => {
      if (where.id) { Object.assign(repository, data); return { count: 1 }; }
      assert.equal(where.organizationId, "org_1"); assert.equal(where.provider, "forgejo"); assert.equal(data.isActive, false);
      operations.push("deactivate"); return { count: 1 };
    },
  },
  $queryRaw: async () => [],
  $transaction: async (run: (tx: typeof client) => unknown) => run(client),
};
mock.module("@octopus/db", () => ({ prisma: client }));
mock.module("@/lib/forgejo", () => ({ validateForgejoConnection: async (host: string) => { validations++; return { host, username }; } }));
mock.module("@/lib/repo-sync", () => ({ syncForgejoRepos: async (orgId: string) => {
  assert.equal(orgId, "org_1"); syncs++;
  if (repoAvailable && !repository.dismissedAt) repository.isActive = true;
  return { synced: 2 };
} }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/events/bus", () => ({ eventBus: { emit: () => {} } }));

const { connectForgejo, disconnectForgejo } = await import("@/app/(app)/settings/integrations/actions");
const form = (host = "https://forge.example.com", token = "test-token-value") => {
  const data = new FormData(); data.set("host", host); data.set("token", token); return data;
};
assert.equal((await connectForgejo(form())).error, "Insufficient permissions.");
member = { role: "member", organizationId: "org_1" };
assert.equal((await connectForgejo(form())).error, "Insufficient permissions.");
assert.equal(validations, 0);
assert.deepEqual(operations, []);

member = { role: "owner", organizationId: "org_1" };
assert.equal((await connectForgejo(form())).synced, 2);
assert.ok(integration);
const saved = integration as Integration;
assert.notEqual(saved.accessTokenEnc, "test-token-value");
assert.equal(decryptString(saved.accessTokenEnc), "test-token-value");
assert.equal(saved.webhookSecret.length, 64);
assert.deepEqual(operations, ["create", "deactivate"]);
assert.equal(syncs, 1);

assert.match((await connectForgejo(form("https://other.example.com"))).error!, /Disconnect/);
assert.equal(validations, 1);
username = "different-user";
assert.match((await connectForgejo(form())).error!, /Disconnect/);
assert.equal(syncs, 1);

username = "review-bot";
assert.equal((await connectForgejo(form(undefined, "replacement-token"))).synced, 2);
assert.equal(decryptString(saved.accessTokenEnc), "replacement-token");
assert.equal(saved.webhookSecret.length, 64);
operations.length = 0;
await disconnectForgejo();
assert.deepEqual(operations, ["disconnect", "deactivate"]);
assert.equal(integration, null);

await connectForgejo(form());
const { transferRepository, restoreRepository } = await import("@/app/(app)/repositories/actions");
assert.match((await transferRepository("repo_1", "org_2")).error!, /cannot be transferred/);
repository.externalId = "https://previous.example.com:1";
assert.match((await restoreRepository("repo_1")).error!, /Reconnect/);
assert.equal(repository.isActive, false);
repository.externalId = "https://forge.example.com:1";
assert.equal((await restoreRepository("repo_1")).success, true);
assert.equal(repository.isActive, true);
assert.equal(repository.dismissedAt, null);
repository.isActive = false;
repository.dismissedAt = new Date();
repoAvailable = false;
assert.match((await restoreRepository("repo_1")).error!, /still administers/);
assert.equal(repository.isActive, false);
assert.ok(repository.dismissedAt instanceof Date);
console.log("forgejo connection checks passed");
