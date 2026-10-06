import assert from "node:assert/strict";
import { mock } from "bun:test";
import { NextRequest } from "next/server";

let signedIn = true;
let role = "owner";
let tokenAuth: { org: { id: string } } | Response | null = null;
let shared = false;
const effects: string[] = [];
const user = { id: "user_1", name: "Test" };
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers() }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user } : null } } }));
mock.module("@/lib/api-auth", () => ({ authenticateApiToken: async () => tokenAuth }));
mock.module("@/lib/entitlements", () => ({ liveTelemetryActive: async () => true }));
mock.module("@/lib/pubby", () => ({ pubby: {
  authenticatePrivateChannel: () => { effects.push("private"); return { auth: "signed" }; },
  authenticatePresenceChannel: () => { effects.push("presence"); return { auth: "signed" }; },
  trigger: async () => { effects.push("trigger"); },
} }));
mock.module("@/lib/stripe", () => ({ createPortalSession: async () => { effects.push("portal"); return "https://billing.example/session"; } }));
mock.module("@/lib/embeddings", () => ({ createEmbeddings: async () => { effects.push("embedding"); return [[1]]; } }));
mock.module("@/lib/qdrant", () => ({ searchDocsChunks: async () => [], ensureDocsCollection: async () => {} }));
mock.module("@anthropic-ai/sdk", () => ({ default: class {
  messages = { stream: async function* () { effects.push("ai"); yield { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }; } };
} }));
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async ({ where }: { where: { organizationId: string; userId: string; deletedAt: null } }) => {
    assert.equal(where.userId, user.id); assert.equal(where.deletedAt, null);
    return where.organizationId === "org_1" ? { role, scopes: [] } : null;
  } },
  organization: { findUnique: async () => ({ stripeCustomerId: "cus_test" }) },
  chatConversation: {
    findFirst: async ({ where }: { where: { id: string; organizationId?: string; userId?: string; deletedAt: null } }) => {
      assert.equal(where.deletedAt, null);
      if (where.id !== "chat_1" || (where.organizationId && where.organizationId !== "org_1") || (where.userId && where.userId !== user.id)) return null;
      return { organizationId: "org_1", isShared: shared };
    },
    update: async ({ data }: { data: { isShared: boolean } }) => { effects.push("share"); shared = data.isShared; return { id: "chat_1", title: "Chat", isShared: shared }; },
  },
  askOctopusSession: {
    findUnique: async () => ({ id: "session_1" }),
    create: async () => { effects.push("session"); return { id: "session_1" }; },
  },
  askOctopusMessage: { create: async () => { effects.push("message"); return {}; } },
} }));

const auth = (await import("@/app/api/pubby/auth/route")).POST;
const trigger = (await import("@/app/api/pubby/trigger/route")).POST;
const portal = (await import("@/app/api/stripe/portal/route")).POST;
const share = await import("@/app/api/chat/conversations/[id]/share/route");
const ask = (await import("@/app/api/ask-octopus/route")).POST;
let requestNumber = 0;
const request = (body: string) => new NextRequest("https://octopus.example/api/test", {
  method: "POST", body, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", "x-forwarded-for": `192.0.2.${++requestNumber}` },
});
const params = { params: Promise.resolve({ id: "chat_1" }) };
const routes = [auth, trigger, portal, (r: Request) => share.POST(r, params), (r: Request) => share.DELETE(r, params), ask];
for (const handler of routes) {
  for (const input of ["", "{", "a=1", "null", "[]", '"text"', "123", "{}"] ) {
    effects.length = 0;
    const response = await handler(request(input));
    assert.equal(response?.status, 400, `${handler.name}: ${input}`);
    assert.deepEqual(effects, [], "malformed input must not cause writes or external calls");
  }
  assert.equal((await handler(request(JSON.stringify({ payload: "x".repeat(1024 * 1024) }))))?.status, 413);
}
for (const [handler, inputs] of [
  [auth, [{ socket_id: "1.2" }, { socket_id: [], channel_name: "presence-org-org_1" }, { socket_id: "1.2", channel_name: null }]],
  [trigger, [{ channel: "presence-org-org_1" }, { channel: {}, event: "typing" }, { channel: "presence-org-org_1", event: null }]],
  [portal, [{ orgId: {} }, { orgId: null }, { orgId: " " }]],
  [ask, [{ message: {} }, { message: "Hi", history: [null] }, { message: "Hi", history: [{ role: "user", content: 5 }] }, { message: "Hi", sessionId: [] }, { message: "Hi", fingerprint: {} }]],
] as const) {
  for (const input of inputs) {
    effects.length = 0;
    assert.equal((await handler(request(JSON.stringify(input)))).status, 400);
    assert.deepEqual(effects, []);
  }
}
const channelBody = JSON.stringify({ socket_id: "1.2", channel_name: "presence-org-org_1" });
const triggerBody = JSON.stringify({ channel: "presence-org-org_1", event: "typing", data: { typing: true } });
signedIn = false;
for (const [handler, body] of [[auth, channelBody], [trigger, triggerBody], [portal, '{"orgId":"org_1"}'], [(r: Request) => share.POST(r, params), '{"orgId":"org_1"}']] as const) {
  effects.length = 0;
  assert.equal((await handler(request(body)))?.status, 401);
  assert.deepEqual(effects, []);
}
signedIn = true;
for (const [handler, body] of [[auth, channelBody], [trigger, triggerBody], [portal, '{"orgId":"org_1"}'], [(r: Request) => share.POST(r, params), '{"orgId":"org_1"}']] as const) {
  effects.length = 0;
  assert.equal((await handler(request(body.replaceAll("org_1", "other_org"))))?.status, 403);
  assert.deepEqual(effects, []);
}
role = "member";
effects.length = 0;
assert.equal((await portal(request('{"orgId":"org_1"}'))).status, 403);
assert.deepEqual(effects, []);
role = "owner";
assert.equal((await auth(request(channelBody))).status, 200);
assert.equal((await trigger(request(triggerBody))).status, 200);
assert.equal((await portal(request('{"orgId":"org_1"}'))).status, 200);
assert.equal((await share.POST(request('{"orgId":"org_1"}'), params))?.status, 200);
assert.equal((await share.DELETE(request('{"orgId":"org_1"}'), params))?.status, 200);
assert.equal((await share.POST(request('{"orgId":"org_1"}'), { params: Promise.resolve({ id: "someone_elses_chat" }) }))?.status, 404);
tokenAuth = { org: { id: "org_1" } };
assert.equal((await auth(request('{"socket_id":"1.2","channel_name":"private-agent-org-org_1"}'))).status, 200);
effects.length = 0;
assert.equal((await auth(request('{"socket_id":"1.2","channel_name":"private-agent-org-other_org"}'))).status, 403);
tokenAuth = new Response("Account held", { status: 403 });
assert.equal((await auth(request(channelBody))).status, 403);
assert.deepEqual(effects, []);
const firstMessage = await ask(request(JSON.stringify({ message: "What is Octopus?", sessionId: null, fingerprint: null, history: [] })));
assert.equal(firstMessage.status, 200);
assert.match(await firstMessage.text(), /Hello/);
assert.ok(effects.includes("ai"));
console.log("input validation checks passed");
