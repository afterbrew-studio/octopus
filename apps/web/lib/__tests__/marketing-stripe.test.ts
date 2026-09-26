import { describe, expect, it } from "bun:test";
import { conversionId, serializeConversion } from "../marketing-conversions";
import { resolveStripeConversion } from "../marketing-stripe";

import { fixture } from "./fixtures/marketing-stripe";

describe("Stripe-backed cash conversion normalization", () => {
  it("reports captured cash instead of plan credit allocation", async () => {
    const f = fixture();
    const result = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(result.event).toMatchObject({ eventType: "purchase", amountMinor: "14800", currency: "USD", purchaseKind: "other_sale", customerId: conversionId("organization", "org_fixture") });
    expect(result.event.occurredAt).toBe(new Date(f.charge.created * 1000).toISOString());
    expect(serializeConversion(result.event)).not.toContain("org_fixture");
    expect(serializeConversion(result.event)).not.toContain("pi_fixture");
  });

  it("normalizes Checkout and PaymentIntent aliases into byte-identical events", async () => {
    const f = fixture();
    f.payment.metadata = {};
    const a = await resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test");
    const b = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(serializeConversion(a.event)).toBe(serializeConversion(b.event));
    expect(a.event).toMatchObject({ purchaseKind: "subscription_initial", transactionId: conversionId("payment", f.payment.id) });
  });

  it("retries an open Checkout without a PaymentIntent and resolves its eventual payment", async () => {
    const f = fixture();
    f.payment.metadata = {};
    f.checkout.status = "open";
    f.checkout.payment_status = "unpaid";
    f.checkout.payment_intent = null;
    await expect(resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test"))
      .rejects.toMatchObject({ code: "checkout_payment_unavailable", retryable: true });
    f.checkout.status = "complete";
    f.checkout.payment_status = "paid";
    f.checkout.payment_intent = f.payment.id;
    const result = await resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test");
    expect(result.event).toMatchObject({ eventType: "purchase", transactionId: conversionId("payment", f.payment.id),
      occurredAt: new Date(f.charge.created * 1000).toISOString(), amountMinor: "14800", currency: "USD" });
  });

  it("does not retry terminal or unsupported Checkout sessions without a payment", async () => {
    const f = fixture();
    f.checkout.payment_intent = null;
    for (const status of ["expired", "complete"] as const) {
      f.checkout.status = status;
      await expect(resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test"))
        .rejects.toMatchObject({ retryable: false });
    }
    f.checkout.status = "open";
    f.checkout.mode = "setup";
    await expect(resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "test"))
      .rejects.toMatchObject({ retryable: false });
    f.checkout.mode = "payment";
    await expect(resolveStripeConversion(f.reader, "purchase", f.checkout.id, "org_fixture", "live"))
      .rejects.toMatchObject({ retryable: false });
  });

  it.each(["credit_purchase", "auto_reload"])("maps %s without changing money", async (type) => {
    const f = fixture(); f.payment.metadata.type = type;
    const result = await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test");
    expect(result.event).toMatchObject({ amountMinor: "14800", purchaseKind: type === "auto_reload" ? "auto_reload" : "top_up" });
  });

  it("preserves GBP minor units without a currency conversion", async () => {
    const f = fixture(); f.payment.currency = "gbp"; f.charge.currency = "gbp";
    expect((await resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).event).toMatchObject({ currency: "GBP", amountMinor: "14800" });
  });

  it.each(["processing", "requires_action", "requires_payment_method", "canceled"] as const)("does not publish a %s payment", async (status) => {
    const f = fixture(); f.payment.status = status;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "payment_not_succeeded" });
  });

  it("rejects cross-environment, cross-org and unsupported cash facts", async () => {
    const f = fixture();
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "live")).rejects.toMatchObject({ code: "stripe_environment_mismatch" });
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "other_org", "test")).rejects.toMatchObject({ code: "payment_organization_mismatch" });
    f.payment.currency = "eur"; f.charge.currency = "eur";
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "unsupported_cash_currency" });
  });

  it.each([0, -10, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid captured amount %s", async (amount) => {
    const f = fixture(); f.payment.amount_received = amount; f.charge.amount_captured = amount;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_cash_amount" });
  });

  it("does not treat authorization or a mismatched charge as received cash", async () => {
    const f = fixture(); f.charge.captured = false;
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "charge_not_captured" });
    f.charge.captured = true; f.charge.payment_intent = "pi_other";
    await expect(resolveStripeConversion(f.reader, "purchase", f.payment.id, "org_fixture", "test")).rejects.toMatchObject({ code: "charge_payment_mismatch" });
  });

  it("emits each successful partial refund and retains its real original payment", async () => {
    const f = fixture();
    const a = await resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test");
    f.refund.id = "re_second"; f.refund.amount = 2000; f.refund.created++;
    const b = await resolveStripeConversion(f.reader, "refund", "re_second", "org_fixture", "test");
    expect(a.event).toMatchObject({ eventType: "refund", amountMinor: "1000", originalTransactionId: conversionId("payment", f.payment.id) });
    expect(b.event).toMatchObject({ eventType: "refund", amountMinor: "2000", originalTransactionId: conversionId("payment", f.payment.id) });
    expect(a.event.eventId).not.toBe(b.event.eventId);
    expect(a.originalPurchase).toEqual(b.originalPurchase);
    expect(a.originalPurchase?.event.amountMinor).toBe("14800");
  });

  it("resolves a pyr refund of a py charge without changing its cash or original identity", async () => {
    const f = fixture();
    f.refund.id = "pyr_fixture";
    f.charge.id = "py_fixture";
    f.payment.latest_charge = f.charge.id;
    f.refund.charge = f.charge.id;
    f.refund.amount = 100;
    const reads: string[] = [];
    f.reader.refund = async id => { reads.push(id); return f.refund; };
    const result = await resolveStripeConversion(f.reader, "refund", f.refund.id, "org_fixture", "test");
    expect(reads).toEqual(["pyr_fixture"]);
    expect(result.event).toEqual({ schemaVersion: 1, eventType: "refund",
      eventId: conversionId("refund", "pyr_fixture"), transactionId: conversionId("refund", "pyr_fixture"),
      originalTransactionId: conversionId("payment", f.payment.id), customerId: conversionId("organization", "org_fixture"),
      amountMinor: "100", currency: "USD", occurredAt: new Date(f.refund.created * 1000).toISOString() });
    expect(result.originalPurchase?.paymentIntentId).toBe(f.payment.id);
    expect(result.originalPurchase?.event.amountMinor).toBe("14800");
  });

  it.each(["py_fixture", "pi_fixture", "seti_fixture", "pyr", "unknown"])("rejects unsupported refund reference %s before a provider read", async reference => {
    const f = fixture();
    let reads = 0;
    f.reader.refund = async () => { reads++; return f.refund; };
    await expect(resolveStripeConversion(f.reader, "refund", reference, "org_fixture", "test"))
      .rejects.toMatchObject({ code: "unsupported_refund_reference" });
    expect(reads).toBe(0);
  });

  it("retains exact object, original-payment, customer, currency and status checks for pyr refunds", async () => {
    const f = fixture();
    const resolve = () => resolveStripeConversion(f.reader, "refund", "pyr_fixture", "org_fixture", "test");
    await expect(resolve()).rejects.toMatchObject({ code: "refund_identity_mismatch" });
    f.refund.id = "pyr_fixture";
    f.refund.payment_intent = "pi_other";
    await expect(resolve()).rejects.toMatchObject({ code: "payment_identity_mismatch" });
    f.refund.payment_intent = f.payment.id;
    f.refund.charge = "py_other";
    await expect(resolve()).rejects.toMatchObject({ code: "refund_payment_mismatch" });
    f.refund.charge = f.charge.id;
    f.refund.currency = "gbp";
    await expect(resolve()).rejects.toMatchObject({ code: "refund_payment_mismatch" });
    f.refund.currency = "usd";
    for (const status of ["pending", "failed", "canceled"]) {
      f.refund.status = status;
      await expect(resolve()).rejects.toMatchObject({ code: "refund_not_succeeded" });
    }
    f.refund.status = "succeeded";
    f.payment.metadata = {};
    f.checkout.customer = "cus_other";
    await expect(resolve()).rejects.toMatchObject({ code: "checkout_payment_mismatch" });
    f.checkout.customer = f.payment.customer;
    f.checkout.metadata = { orgId: "other_org", type: "subscription_start" };
    await expect(resolve()).rejects.toMatchObject({ code: "payment_organization_mismatch" });
    f.checkout.metadata = { orgId: "org_fixture", type: "subscription_start" };
    f.payment.livemode = true;
    await expect(resolve()).rejects.toMatchObject({ code: "stripe_environment_mismatch" });
  });

  it.each(["pending", "failed", "canceled"])("does not publish a %s refund", async (status) => {
    const f = fixture(); f.refund.status = status;
    await expect(resolveStripeConversion(f.reader, "refund", "re_fixture", "org_fixture", "test")).rejects.toMatchObject({ code: "refund_not_succeeded" });
  });

  it.each(["re_fixture", "pyr_fixture"])("holds %s with inconsistent original charge, amount or timestamp", async (reference) => {
    const f = fixture(); f.refund.id = reference; f.refund.amount = 20_000;
    await expect(resolveStripeConversion(f.reader, "refund", reference, "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_refund_amount_or_time" });
    f.refund.amount = 1000; f.refund.created = f.charge.created - 1;
    await expect(resolveStripeConversion(f.reader, "refund", reference, "org_fixture", "test")).rejects.toMatchObject({ code: "invalid_refund_amount_or_time" });
    f.refund.created = f.charge.created + 1; f.refund.charge = "ch_other";
    await expect(resolveStripeConversion(f.reader, "refund", reference, "org_fixture", "test")).rejects.toMatchObject({ code: "refund_payment_mismatch" });
  });
});
