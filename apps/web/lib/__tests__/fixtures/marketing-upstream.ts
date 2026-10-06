import { cashDigest } from "../../marketing-cash-compare";
import { normalizeMarketingCash } from "../../marketing-cash-contract";
import { serializeConversion } from "../../marketing-conversions";
import { resolveStripeConversion } from "../../marketing-stripe";
import { UPSTREAM_API_VERSION, type AuditInput } from "../../marketing-upstream-audit";
import { fixture } from "./marketing-stripe";

/** Synthetic processor transcript; no SDK, credentials or network. */
export async function upstreamFixture() {
  const f = fixture();
  f.payment.metadata.type = f.checkout.metadata.type = "credit_purchase";
  const charge = { ...f.charge, customer: f.payment.customer };
  const from = new Date((charge.created - 1) * 1000).toISOString();
  const to = new Date((charge.created + 120) * 1000).toISOString();
  const binding = { sourceId: "11111111-1111-4111-8111-111111111111", environment: "test" as const, keyId: "22222222-2222-4222-8222-222222222222", capabilities: ["purchases", "refunds"], project: { projectId: "33333333-3333-4333-8333-333333333333", version: 1 } };
  const ownership = [{ orgId: "org_fixture", customerId: "cus_fixture" }];
  const events = await Promise.all([
    resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test"),
    resolveStripeConversion(f.reader, "refund", f.refund.id, "org_fixture", "test"),
  ]);
  const members = events.map(({ event }, i) => ({ ...normalizeMarketingCash(serializeConversion(event)), receiptId: `${i + 4}4444444-4444-4444-8444-444444444444`, dependency: false }));
  const ledger = members.map((m, i) => ({ id: `ledger_${i}`, organizationId: "org_fixture", type: i ? "refund" : "purchase", createdAt: m.occurredAt, stripeSessionId: i ? null : f.checkout.id, stripeRefundId: i ? f.refund.id : null }));
  const outbox = ledger.map((l, i) => ({ id: `outbox_${i}`, originKey: `ledger:${l.id}`, organizationId: l.organizationId, sourceCreatedAt: l.createdAt, reference: l.stripeRefundId ?? l.stripeSessionId, payload: serializeConversion(events[i]!.event), status: "delivered", receiptId: members[i]!.receiptId, httpStatus: 201 }));
  const retained = { schemaVersion: 1, captureContract: "retained-cash/v1", normalizationContract: "unified-ads/conversion-event-semantic/v1", producerObservation: { startedAt: to, completedAt: to }, binding, activationFrom: from, scope: { from, to }, B: "complete_retained_scope", C: "unknown", gaps: [], ledger, outbox, members };
  const retainedBody = JSON.stringify(retained);
  const input: AuditInput = { pins: { accountId: "acct_fixture", environment: "test", apiVersion: UPSTREAM_API_VERSION, activationFrom: from, from, to, binding, ownershipDigest: cashDigest(JSON.stringify(ownership)), retainedDigest: cashDigest(retainedBody), predecessorDigest: null }, transportBinding: { accountId: "acct_fixture", environment: "test", apiVersion: UPSTREAM_API_VERSION }, ownership, retainedBody };
  const list = (data: unknown[]) => ({ object: "list", data, has_more: false });
  const responses: Record<string, unknown> = {
    "/v1/account": { id: "acct_fixture" }, "/v1/charges": list([charge]), "/v1/refunds": list([f.refund]),
    [`/v1/payment_intents/${f.payment.id}`]: f.payment, "/v1/checkout/sessions": list([f.checkout]), [`/v1/charges/${charge.id}`]: charge,
  };
  const requests: Request[] = [];
  const send = async (r: Request) => {
    requests.push(r);
    const response = responses[new URL(r.url).pathname];
    if (!response) throw new Error("unexpected_fixture_read");
    return Response.json(response);
  };
  const seal = () => { input.retainedBody = JSON.stringify(retained); input.pins.retainedDigest = cashDigest(input.retainedBody); };
  return { input, retained, responses, requests, send, seal, ...f, charge, now: Date.parse(to) + 1000 };
}
