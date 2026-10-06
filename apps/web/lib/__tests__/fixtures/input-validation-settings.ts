import assert from "node:assert/strict";
import { mock } from "bun:test";

let signedIn = true;
let role = "owner";
let orgId = "org_1";
let held = false;
const writes: { operation: string; data: Record<string, unknown> }[] = [];
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: orgId }), set: () => {} }) }));
mock.module("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user: { id: "user_1" } } : null } } }));
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async ({ where }: { where: { organizationId: string; userId: string; deletedAt: null } }) => {
    assert.equal(where.userId, "user_1"); assert.equal(where.deletedAt, null);
    return where.organizationId === "org_1" ? { role, scopes: [] } : null;
  } },
  organization: {
    findUnique: async () => ({ stripeCustomerId: null }),
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      assert.equal(where.id, "org_1"); writes.push({ operation: "organization", data }); return { stripeCustomerId: null };
    },
  },
  user: { update: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ operation: "user", data }); return {}; } },
  orgApiToken: {
    count: async () => 0,
    create: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ operation: "token", data }); return {}; },
    findFirst: async ({ where }: { where: { id: string; organizationId: string } }) => where.id === "token_1" && where.organizationId === "org_1" ? { id: "token_1" } : null,
    update: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ operation: "revoke", data }); return {}; },
  },
} }));
mock.module("@/lib/account-standing", () => ({ getAccountStanding: async () => ({ held }), ACCOUNT_HOLD_MESSAGE: "Account held" }));
mock.module("@/lib/api-auth", () => ({ generateApiToken: () => "test-token", hashToken: () => "hash", getTokenPrefix: () => "prefix" }));
mock.module("@/lib/stripe", () => ({
  createCheckoutSession: async () => { throw new Error("unexpected payment"); },
  createSubscriptionCheckoutSession: async () => { throw new Error("unexpected subscription"); },
  getOffSessionPaymentMethodId: async () => null,
  getOrCreateStripeCustomer: async () => { throw new Error("unexpected Stripe customer"); },
  getStripe: () => { throw new Error("unexpected Stripe call"); },
}));
mock.module("@/lib/marketing-capture", () => ({ beginMarketingPayment: async () => { throw new Error("unexpected payment"); } }));
mock.module("@/lib/credits", () => ({
  chargeCreditsOffSession: async () => { throw new Error("unexpected charge"); },
  rearmAutoReloadAfterPaymentMethodChange: async () => {},
  updateAutoReloadConfigDurably: async (_org: string, enabled: boolean, threshold: number, amount: number) => { writes.push({ operation: "reload", data: { enabled, threshold, amount } }); },
}));
mock.module("@/lib/subscription", () => ({ chargeSubscription: async () => {}, grantSubscriptionPeriod: async () => {}, addOneMonth: () => new Date() }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: async () => {} } }));
mock.module("@/lib/elasticsearch", () => ({ writeSyncLog: async () => {}, deleteSyncLogs: async () => {} }));
mock.module("@/lib/github", () => ({ GithubRateLimitError: class extends Error {} }));
mock.module("@/lib/repo-sync", () => ({ syncOrgRepos: async () => {} }));
mock.module("@/lib/org-create", () => ({ WELCOME_DEFERRED_REASON: "deferred" }));
mock.module("@/lib/org-limits", () => ({ canUserCreateOrg: async () => true, hasEverOwnedOrg: async () => false }));
mock.module("@/lib/welcome-credit", () => ({ assessWelcomeCredit: async () => ({}), logWelcomeOutcome: async () => {} }));
mock.module("@/lib/indexing-abort", () => ({ createAbortController: () => new AbortController(), abortIndexing: () => {} }));
mock.module("@/lib/indexing-runner", () => ({ runIndexingInBackground: () => {} }));
mock.module("@/lib/crypto", () => ({ encryptString: () => "encrypted-test-value" }));
mock.module("@/lib/audit", () => ({ writeAuditLog: async () => {} }));
mock.module("@/lib/entitlements", () => ({ canUseLiveTelemetry: async () => false }));
mock.module("@/lib/request-ip", () => ({ getClientIp: () => "192.0.2.1" }));
mock.module("@/lib/presence", () => ({ clearPresence: async () => {} }));

const actions = await import("@/app/(app)/actions");
const billing = await import("@/app/(app)/settings/billing/actions");
const tokens = await import("@/app/(app)/settings/api-tokens/actions");
const form = (fields: Record<string, string | Blob>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const modelFields = { defaultModelId: "", defaultEmbedModelId: "", reviewEffort: "" };
const checkedActions = [
  [actions.updateOrganizationName, { name: "New name" }],
  [actions.updateApiKeys, { openaiApiKey: "sk-test" }],
  [actions.updateDefaultModels, modelFields],
  [actions.updateCheckFailureThreshold, { threshold: "critical" }],
  [actions.toggleReviewsPaused, { paused: "true" }],
  [actions.toggleAutoDiscoverRepos, { enabled: "true" }],
  [actions.toggleLiveTelemetry, { enabled: "false" }],
  [actions.toggleVendorMemberVisibility, { allowed: "true" }],
  [billing.updateAutoReload, { enabled: "false", thresholdAmount: "10", reloadAmount: "50" }],
  [billing.updateBillingEmail, { billingEmail: "test@example.com" }],
  [billing.updateSpendLimit, { monthlySpendLimitUsd: "10" }],
] as const;
for (const [action, validFields] of checkedActions) {
  for (const invalid of [null, {}, [], "bad", form({ ...validFields, [Object.keys(validFields)[0]!]: new Blob(["bad"]) }), form({ ...validFields, [Object.keys(validFields)[0]!]: "nul\0value" })]) {
    writes.length = 0;
    assert.ok((await action({}, invalid as FormData)).error, action.name);
    assert.deepEqual(writes, [], action.name);
  }
  for (const badRole of ["member", "outsider"]) {
    role = badRole === "outsider" ? "owner" : badRole;
    orgId = badRole === "outsider" ? "other_org" : "org_1";
    writes.length = 0;
    assert.ok((await action({}, form(validFields))).error, `${action.name}: ${badRole}`);
    assert.deepEqual(writes, []);
  }
  orgId = "org_1"; role = "owner";
  signedIn = false;
  await assert.rejects(() => action({}, form(validFields)), /redirect:\/login/);
  signedIn = true;
}
for (const action of [actions.createOrganization, actions.updateUserName]) {
  assert.ok((await action({}, {} as FormData)).error);
  assert.ok((await action({}, form({ name: new Blob(["bad"]) }))).error);
}
for (const action of [tokens.createApiToken, tokens.deleteApiToken]) {
  for (const invalid of [null, {}, form({ name: new Blob(["bad"]), tokenId: new Blob(["bad"]) })]) {
    writes.length = 0;
    assert.ok((await action(invalid as FormData)).error);
    assert.deepEqual(writes, []);
  }
  signedIn = false;
  assert.ok((await action(form({ name: "Test", tokenId: "token_1" }))).error);
  signedIn = true;
  for (const badRole of ["member", "outsider"]) {
    role = badRole === "outsider" ? "owner" : badRole; orgId = badRole === "outsider" ? "other_org" : "org_1";
    writes.length = 0;
    assert.ok((await action(form({ name: "Test", tokenId: "token_1" }))).error);
    assert.deepEqual(writes, []);
  }
  orgId = "org_1"; role = "owner";
}
held = true;
writes.length = 0;
assert.equal((await tokens.createApiToken(form({ name: "Test" }))).error, "Account held");
assert.deepEqual(writes, []);
held = false;
for (const action of [actions.updateDefaultModels, actions.toggleReviewsPaused, actions.toggleAutoDiscoverRepos, actions.toggleLiveTelemetry, actions.toggleVendorMemberVisibility, billing.updateAutoReload, billing.updateBillingEmail, billing.updateSpendLimit]) {
  writes.length = 0;
  assert.ok((await action({}, new FormData())).error, `${action.name}: missing fields`);
  assert.deepEqual(writes, []);
}
for (const [action, fields] of checkedActions) {
  assert.equal((await action({}, form(fields))).error, undefined, `${action.name}: valid form`);
}
assert.ok(writes.some(({ data }) => data.defaultModelId === null && data.defaultEmbedModelId === null), "empty selections inherit defaults");
assert.equal((await billing.updateBillingEmail({}, form({ billingEmail: "" }))).error, undefined);
assert.equal(writes.at(-1)?.data.billingEmail, null, "explicit empty field clears billing email");
assert.equal((await tokens.createApiToken(form({ name: "Test" }))).token, "test-token");
assert.equal((await tokens.deleteApiToken(form({ tokenId: "token_1" }))).error, undefined);
writes.length = 0;
assert.ok((await tokens.deleteApiToken(form({ tokenId: "other_token" }))).error);
assert.deepEqual(writes, []);
console.log("input validation checks passed");
