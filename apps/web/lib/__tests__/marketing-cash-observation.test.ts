import { describe, it, expect, mock } from "bun:test";
import { randomUUID } from "node:crypto";
import type { MarketingConversion } from "@octopus/db";
import { conversionId, type MarketingConfig } from "../marketing-conversions";
import { normalizeMarketingCash } from "../marketing-cash-contract";
import { cashBinding, compareCashBatch, validateCashComparison } from "../marketing-cash-compare";
import vectors from "./fixtures/marketing-cash-vectors.json";
mock.module("server-only", () => ({}));
mock.module("@octopus/db", () => ({ Prisma: { DbNull: null }, prisma: {} }));
const { assembleCashInventory } = await import("../marketing-cash-observation");
const keyId = randomUUID();
const config: MarketingConfig = { sourceId: randomUUID(), environment: "test", serverKey: `uads_${keyId}_${"a".repeat(43)}`, from: new Date("2026-09-01T00:00:00.000Z") };
const binding = cashBinding(config, JSON.stringify({ sourceId: config.sourceId, environment: "test", keyId, capabilities: ["purchases", "refunds"], project: { projectId: randomUUID(), version: 3 } }));
const scope = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T00:00:00.000Z" };
const date = new Date("2026-09-22T00:00:00.000Z");
function fact(id = "one") { return { id, organizationId: "org", createdAt: date, type: "purchase", stripeSessionId: "pi_fixture", stripeRefundId: null }; }
function row(id = "one"): MarketingConversion {
  const txn = conversionId("payment", "pi_fixture");
  return { id, sourceId: config.sourceId, environment: "test", originKey: `ledger:${id}`, kind: "purchase", reference: "pi_fixture", organizationId: "org", sourceCreatedAt: date, createdAt: date, updatedAt: date,
    payload: JSON.stringify({ schemaVersion: 1, eventId: txn, eventType: "purchase", transactionId: txn, customerId: conversionId("organization", "org"), occurredAt: date.toISOString(), amountMinor: "5000", currency: "USD", purchaseKind: "top_up" }),
    status: "delivered", attempts: 1, nextAttemptAt: date, leaseId: null, leaseUntil: null, receiptId: randomUUID(), httpStatus: 201, errorCode: null, deliveredAt: date };
}
describe("retained cash observation", () => {
  it("matches immutable receiver vectors independently and rejects malformed persisted bytes", () => {
    for (const v of vectors.vectors) { const p = normalizeMarketingCash(JSON.stringify(v.input)); expect(p.semanticDigest).toBe(v.semanticDigest); expect(p.semanticJson).toBe(v.semanticJson); }
    for (const v of vectors.rejected) expect(() => normalizeMarketingCash(JSON.stringify(v.input))).toThrow();
  });
  it("accounts for missing capture, unresolved payload, blocked delivery and truncation", () => {
    const r = row();
    expect(assembleCashInventory(config, binding, scope, [fact()], [r], false).B).toBe("complete_retained_scope");
    for (const rows of [[], [{ ...r, payload: null }], [{ ...r, status: "blocked", receiptId: null, deliveredAt: null }]]) expect(assembleCashInventory(config, binding, scope, [fact()], rows, false).B).toBe("incomplete");
    expect(assembleCashInventory(config, binding, scope, [fact()], [r], true).B).toBe("incomplete");
  });
  it("collapses equal aliases but cannot hide conflicting payloads or receipt identities", () => {
    const r = row(); const alias = { ...r, id: "two", originKey: "ledger:two", reference: "cs_alias" }; const ledger = [fact(), { ...fact("two"), stripeSessionId: "cs_alias" }];
    const inv = assembleCashInventory(config, binding, scope, ledger, [r, alias], false); expect(inv.members).toHaveLength(1); expect(inv.members[0]!.aliases).toHaveLength(2);
    expect(assembleCashInventory(config, binding, scope, ledger, [r, { ...alias, receiptId: randomUUID() }], false).B).toBe("incomplete");
    expect(assembleCashInventory(config, binding, scope, ledger, [r, { ...alias, payload: r.payload!.replace('"5000"', '"5001"') }], false).members).toHaveLength(0);
  });
  it("retains exact old original dependency rather than reclassifying it as new-period cash", () => {
    const purchase = row(); purchase.originKey = "payment:pi_fixture"; purchase.sourceCreatedAt = new Date("2026-08-01T00:00:00.000Z");
    purchase.payload = purchase.payload!.replace(date.toISOString(), purchase.sourceCreatedAt.toISOString());
    const refund = row("refund"); refund.kind = "refund"; refund.reference = "pyr_fixture";
    refund.payload = JSON.stringify({ schemaVersion: 1, eventId: conversionId("refund", refund.reference), eventType: "refund", transactionId: conversionId("refund", refund.reference), originalTransactionId: conversionId("payment", "pi_fixture"), customerId: conversionId("organization", "org"), amountMinor: "100", currency: "USD", occurredAt: date.toISOString() });
    const l = { ...fact("refund"), type: "usage", stripeSessionId: null, stripeRefundId: "pyr_fixture" };
    const inv = assembleCashInventory(config, binding, scope, [l], [refund, purchase], false);
    expect(inv.B).toBe("complete_retained_scope"); expect(inv.members.find(m => m.eventType === "purchase")?.dependency).toBe(true);
    expect(assembleCashInventory(config, binding, scope, [l], [refund], false).B).toBe("incomplete");
  });
  it("validates independent binding before transport, and records lost-ACK match without row mutation", async () => {
    expect(() => cashBinding(config, undefined)).toThrow(); expect(() => cashBinding(config, JSON.stringify({ ...binding, project: { projectId: binding.project.projectId } }))).toThrow();
    const r = { ...row(), status: "pending", receiptId: null, deliveredAt: null, httpStatus: null };
    const before = JSON.stringify(r); const inv = assembleCashInventory(config, binding, scope, [fact()], [r], false); const member = inv.members[0]!;
    const entries = [{ eventType: member.eventType, transactionId: member.transactionId, semanticDigest: member.semanticDigest, receiptId: null }];
    let calls = 0; const response = { schemaVersion: 1, ...binding, observation: { startedAt: date.toISOString(), completedAt: date.toISOString() }, entries: [{ eventType: member.eventType, transactionId: member.transactionId, status: "matched", receiptId: randomUUID(), receivedAt: date.toISOString() }] };
    const send = (async (input: RequestInfo | URL) => { const req = input as Request; calls++; expect(req.headers.has("origin")).toBe(false); expect(req.headers.has("cookie")).toBe(false); expect(req.redirect).toBe("error"); expect(req.url.startsWith("https://ads.weezboo.com/api/conversion-events")).toBe(true); return Response.json(req.method === "GET" ? { schemaVersion: 1, sourceId: binding.sourceId, environment: binding.environment, keyId, capabilities: binding.capabilities } : response); }) as typeof fetch;
    await compareCashBatch(config, binding, entries, send); expect(calls).toBe(2); expect(JSON.stringify(r)).toBe(before); expect(inv.B).toBe("incomplete");
    expect(() => validateCashComparison(response, { ...binding, project: { ...binding.project, version: 4 } }, entries)).toThrow();
    expect(() => validateCashComparison({ ...response, entries: [] }, binding, entries)).toThrow();
    expect(() => validateCashComparison({ ...response, entries: [{ ...response.entries[0], status: "alien" }] }, binding, entries)).toThrow();
  });
  it("rejects invalid owner bindings before transport and rejected identities before comparison", async () => {
    const entries = [{ eventType: "purchase" as const, transactionId: "payment_fixture", semanticDigest: "a".repeat(64), receiptId: null }];
    for (const change of [
      { sourceId: randomUUID() }, { environment: "live" }, { keyId: randomUUID() },
      { capabilities: ["purchases"] }, { capabilities: ["purchases", "refunds", "refunds"] },
      { project: { projectId: binding.project.projectId } },
      { project: { ...binding.project, version: 0 } },
      { project: { ...binding.project, version: "7" } },
    ]) {
      let calls = 0;
      await expect(compareCashBatch(config, { ...binding, ...change } as typeof binding, entries, (async () => { calls++; throw Error("must not send"); }) as typeof fetch)).rejects.toThrow();
      expect(calls).toBe(0);
    }
    for (const change of [{ sourceId: randomUUID() }, { environment: "live" }, { keyId: randomUUID() }, { capabilities: ["purchases"] }]) {
      const methods: string[] = [];
      await expect(compareCashBatch(config, binding, entries, (async (input: RequestInfo | URL) => {
        methods.push((input as Request).method);
        return Response.json({ schemaVersion: 1, sourceId: binding.sourceId, environment: binding.environment, keyId, capabilities: binding.capabilities, ...change });
      }) as typeof fetch)).rejects.toThrow();
      expect(methods).toEqual(["GET"]);
    }
  });
  it("requires exact ordered comparison replies with independent project and receipt authority", () => {
    const entries = ["one", "two"].map(transactionId => ({ eventType: "purchase" as const, transactionId, semanticDigest: "a".repeat(64), receiptId: randomUUID() }));
    const response = { schemaVersion: 1, ...binding, observation: { startedAt: date.toISOString(), completedAt: date.toISOString() }, entries: entries.map(e => ({ eventType: e.eventType, transactionId: e.transactionId, status: "matched", receiptId: e.receiptId, receivedAt: date.toISOString() })) };
    expect(validateCashComparison(response, binding, entries)).toEqual(response);
    for (const change of [
      { project: { projectId: binding.project.projectId } }, { project: { ...binding.project, version: binding.project.version + 1 } },
      { project: { ...binding.project, projectId: randomUUID() } }, { sourceId: randomUUID() }, { environment: "live" }, { keyId: randomUUID() },
      { capabilities: ["purchases"] }, { entries: [...response.entries].reverse() },
      { entries: [response.entries[0]] }, { entries: [response.entries[0], response.entries[0]] },
      { entries: [{ ...response.entries[0], receiptId: randomUUID() }, response.entries[1]] },
      { observation: { startedAt: date.toISOString(), completedAt: "2026-09-21T00:00:00.000Z" } },
    ]) expect(() => validateCashComparison({ ...response, ...change }, binding, entries)).toThrow();
  });
});
