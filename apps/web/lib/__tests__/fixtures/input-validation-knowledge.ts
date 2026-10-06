import assert from "node:assert/strict";
import { mock } from "bun:test";
let signedIn = true;
let selectedOrg = "org_1";
let member = true;
let queries = 0;
let providerCalls = 0;
let mutations = 0;
const failures: string[] = [];
const check = async (name: string, run: () => Promise<void>) => { try { await run(); } catch (error) { failures.push(`${name}: ${error}`); } };
mock.module("server-only", () => ({}));
mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: selectedOrg }) }) }));
mock.module("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
mock.module("next/cache", () => ({ revalidatePath: () => {} }));
mock.module("@/lib/auth", () => ({ auth: { api: { getSession: async () => signedIn ? { user: { id: "user_1" } } : null } } }));
mock.module("@/lib/pubby", () => ({ pubby: { trigger: () => {} } }));
mock.module("@/lib/events", () => ({ eventBus: { emit: () => {} } }));
mock.module("@/lib/qdrant", () => ({ deleteKnowledgeDocumentChunks: async () => { mutations++; } }));
mock.module("@/lib/knowledge-indexer", () => ({ indexKnowledgeDocument: async () => ({ totalChunks: 1, totalVectors: 1, durationMs: 1 }) }));
mock.module("@/lib/crypto", () => ({ decryptStringMaybeLegacy: () => "fake-key" }));
mock.module("@/lib/ai-usage", () => ({ logAiUsage: async () => {} }));
mock.module("@anthropic-ai/sdk", () => ({ default: class {
  messages = { create: async () => { providerCalls++; return { content: [{ type: "text", text: "Enhanced" }], usage: { input_tokens: 1, output_tokens: 1 } }; } };
} }));
mock.module("@octopus/db", () => ({ prisma: {
  organizationMember: { findFirst: async ({ where }: { where: { userId: string; organizationId: string; deletedAt: null } }) => {
    assert.equal(where.userId, "user_1"); assert.equal(where.deletedAt, null);
    return member && where.organizationId === "org_1" ? { id: "member_1" } : null;
  } },
  organization: { findUnique: async () => { queries++; return { anthropicApiKey: "fake-key" }; } },
  knowledgeDocument: {
    findUnique: async ({ where, select }: { where: { id: string }; select: { organization: { select: { members: { where: { userId: string; deletedAt: null } } } } } }) => {
      queries++; assert.equal(typeof where.id, "string");
      assert.equal(select.organization.select.members.where.userId, "user_1"); assert.equal(select.organization.select.members.where.deletedAt, null);
      return where.id === "doc_1" ? { id: "doc_1", title: "Title", content: "Content", organizationId: "org_1", deletedAt: new Date(), organization: { members: member ? [{ id: "member_1" }] : [] } } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => { mutations++; assert.equal(data.organizationId, "org_1"); return { ...data, id: "doc_1" }; },
    update: async () => { mutations++; },
  },
  knowledgeAuditLog: {
    create: async () => { mutations++; },
    findMany: async ({ where }: { where: { documentId: string; organizationId: string } }) => {
      queries++; assert.equal(typeof where.documentId, "string"); assert.equal(where.documentId, "doc_1"); assert.equal(where.organizationId, "org_1");
      return [{ id: "audit_1", createdAt: new Date("2026-10-06"), user: { name: "Member" }, action: "updated", details: "Edit" }];
    },
  },
} }));
const actions = await import("@/app/(app)/knowledge/actions");
const form = () => { const f = new FormData(); f.set("title", "Title"); f.set("content", "Content"); return f; };
const documentActions = [actions.getKnowledgeDocument, actions.deleteKnowledgeDocument, actions.restoreKnowledgeDocument,
  (id: string) => actions.updateKnowledgeDocument(id, form()), (id: string) => actions.setKnowledgeAlwaysInclude(id, true)];
for (const invalid of [null, {}, [], "", "nul\0value", "bad\ud800", "x".repeat(1025)]) {
  for (const action of documentActions) await check("invalid document ID", async () => {
    queries = 0; mutations = 0;
    assert.ok("error" in await action(invalid as string)); assert.equal(queries, 0); assert.equal(mutations, 0);
  });
  await check("invalid audit ID", async () => { queries = 0; assert.deepEqual(await actions.getKnowledgeAuditLogs(invalid as string), []); assert.equal(queries, 0); });
}
for (const invalid of [null, {}, [], "nul\0value"]) {
  await check("invalid enhance content", async () => { providerCalls = 0; assert.ok((await actions.enhanceKnowledgeContent(invalid as string)).error); assert.equal(providerCalls, 0); });
}
for (const invalid of [null, {}, [], (() => { const f = form(); f.set("title", new Blob(["bad"])); return f; })(), (() => { const f = form(); f.set("content", "bad\0text"); return f; })()]) {
  for (const action of [(f: FormData) => actions.createKnowledgeDocument({}, f), (f: FormData) => actions.updateKnowledgeDocument("doc_1", f)]) await check("invalid document form", async () => {
    mutations = 0; assert.ok((await action(invalid as FormData)).error); assert.equal(mutations, 0);
  });
}
await check("invalid pin flag", async () => { mutations = 0; assert.ok((await actions.setKnowledgeAlwaysInclude("doc_1", {} as boolean)).error); assert.equal(mutations, 0); });
for (const outsider of ["forged_cookie", "removed_member"]) {
  selectedOrg = outsider === "forged_cookie" ? "other_org" : "org_1"; member = outsider !== "removed_member";
  await check(`${outsider} audit`, async () => { queries = 0; assert.deepEqual(await actions.getKnowledgeAuditLogs("doc_1"), []); assert.equal(queries, 0); });
  await check(`${outsider} enhance`, async () => { providerCalls = 0; queries = 0; assert.ok((await actions.enhanceKnowledgeContent("Content")).error); assert.equal(providerCalls, 0); assert.equal(queries, 0); });
  for (const action of documentActions) await check(`${outsider} document access`, async () => { mutations = 0; assert.ok("error" in await action("doc_1")); assert.equal(mutations, 0); });
}
selectedOrg = "org_1"; member = true; signedIn = false;
for (const action of [...documentActions, actions.getKnowledgeAuditLogs, actions.enhanceKnowledgeContent, actions.addKnowledgeTemplate]) {
  await check("signed out", async () => { mutations = 0; providerCalls = 0; await assert.rejects(() => action("doc_1"), /redirect:\/login/); assert.equal(mutations, 0); assert.equal(providerCalls, 0); });
}
signedIn = true;
await check("valid authorized calls", async () => {
  assert.equal((await actions.getKnowledgeDocument("doc_1") as { content: string }).content, "Content");
  assert.equal((await actions.getKnowledgeAuditLogs("doc_1"))[0]?.userName, "Member");
  assert.equal((await actions.enhanceKnowledgeContent("Content")).content, "Enhanced");
  assert.equal((await actions.setKnowledgeAlwaysInclude("doc_1", false)).error, undefined);
  assert.equal((await actions.createKnowledgeDocument({}, form())).error, undefined);
  assert.equal((await actions.updateKnowledgeDocument("doc_1", form())).error, undefined);
});
assert.deepEqual(failures, []);
console.log("input validation checks passed");
