import type Stripe from "stripe";
import { conversionId, type ConversionEvent, type MarketingConfig, type PurchaseEvent, type PurchaseKind } from "./marketing-conversions";

type Payment = Pick<Stripe.PaymentIntent, "id" | "status" | "amount_received" | "currency" | "customer" | "metadata" | "latest_charge" | "livemode" | "capture_method">;
type Checkout = Pick<Stripe.Checkout.Session, "id" | "status" | "mode" | "payment_status" | "payment_intent" | "customer" | "metadata" | "livemode">;
type Charge = Pick<Stripe.Charge, "id" | "created" | "status" | "paid" | "captured" | "amount_captured" | "currency" | "payment_intent" | "livemode">;
type Refund = Pick<Stripe.Refund, "id" | "created" | "status" | "amount" | "currency" | "payment_intent" | "charge">;

/** Read-only surface: the collector cannot charge, refund, or allocate credits. */
export interface MarketingStripeReader {
  payment(id: string): Promise<Payment>;
  checkout(id: string): Promise<Checkout>;
  checkoutsForPayment(id: string): Promise<Checkout[]>;
  charge(id: string): Promise<Charge>;
  refund(id: string): Promise<Refund>;
}

export function marketingStripeReader(stripe: Stripe): MarketingStripeReader {
  const options = { timeout: 10_000, maxNetworkRetries: 0 };
  return {
    payment: (id) => stripe.paymentIntents.retrieve(id, {}, options),
    checkout: (id) => stripe.checkout.sessions.retrieve(id, {}, options),
    checkoutsForPayment: async (id) => {
      const result = await stripe.checkout.sessions.list({ payment_intent: id, limit: 2 }, options);
      if (result.has_more || result.data.length > 1) throw new MarketingSourceError("ambiguous_checkout");
      return result.data;
    },
    charge: (id) => stripe.charges.retrieve(id, {}, options),
    refund: (id) => stripe.refunds.retrieve(id, {}, options),
  };
}

export class MarketingSourceError extends Error {
  constructor(readonly code: string, readonly retryable = false) {
    super(code);
    this.name = "MarketingSourceError";
  }
}

function objectId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function positiveMinor(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 999_999_999_999_999) throw new MarketingSourceError("invalid_cash_amount");
  return String(value);
}

function cashCurrency(value: string): "GBP" | "USD" {
  if (value === "gbp") return "GBP";
  if (value === "usd") return "USD";
  throw new MarketingSourceError("unsupported_cash_currency");
}

function processorTime(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(new Date(seconds * 1000).getTime())) throw new MarketingSourceError("invalid_processor_timestamp");
  return new Date(seconds * 1000).toISOString();
}

function purchaseKind(type: string | undefined): PurchaseKind | null {
  switch (type) {
    case "credit_purchase": return "top_up";
    case "auto_reload": return "auto_reload";
    case "subscription_start": return "subscription_initial";
    // Existing off-session metadata does not distinguish first payment from
    // renewal. Do not infer that distinction from today's plan or ledger text.
    case "subscription": return "other_sale";
    default: return null;
  }
}

async function paymentEvent(
  reader: MarketingStripeReader,
  reference: string,
  organizationId: string,
  environment: MarketingConfig["environment"],
): Promise<{ event: PurchaseEvent; paymentIntentId: string; chargeId: string }> {
  let checkout: Checkout | undefined;
  let paymentIntentId = reference;
  if (reference.startsWith("cs_")) {
    checkout = await reader.checkout(reference);
    if (checkout.id !== reference) throw new MarketingSourceError("checkout_identity_mismatch");
    paymentIntentId = objectId(checkout.payment_intent) ?? "";
    if (!paymentIntentId) throw new MarketingSourceError("checkout_payment_unavailable",
      checkout.status === "open" && checkout.mode === "payment" && checkout.livemode === (environment === "live"));
  }
  if (!paymentIntentId.startsWith("pi_")) throw new MarketingSourceError("unsupported_payment_reference");
  const payment = await reader.payment(paymentIntentId);
  if (payment.id !== paymentIntentId) throw new MarketingSourceError("payment_identity_mismatch");
  if (payment.livemode !== (environment === "live")) throw new MarketingSourceError("stripe_environment_mismatch");
  if (payment.status !== "succeeded") throw new MarketingSourceError("payment_not_succeeded", payment.status !== "canceled");
  if (payment.capture_method === "manual") throw new MarketingSourceError("unsupported_manual_capture");
  if (!checkout && (!payment.metadata.orgId || !purchaseKind(payment.metadata.type))) {
    const sessions = await reader.checkoutsForPayment(payment.id);
    if (sessions.length > 1) throw new MarketingSourceError("ambiguous_checkout");
    checkout = sessions[0];
  }
  if (checkout) {
    if (checkout.mode !== "payment" || objectId(checkout.payment_intent) !== payment.id || checkout.livemode !== payment.livemode || objectId(checkout.customer) !== objectId(payment.customer)) throw new MarketingSourceError("checkout_payment_mismatch");
    if (checkout.payment_status !== "paid") throw new MarketingSourceError("checkout_not_paid", true);
  }
  const owners = [payment.metadata.orgId, checkout?.metadata?.orgId].filter(Boolean);
  if (!organizationId || !owners.length || owners.some((owner) => owner !== organizationId)) throw new MarketingSourceError("payment_organization_mismatch");
  const kinds = [purchaseKind(payment.metadata.type), purchaseKind(checkout?.metadata?.type)].filter((kind): kind is PurchaseKind => kind !== null);
  if (!kinds.length || kinds.some((kind) => kind !== kinds[0])) throw new MarketingSourceError("unsupported_payment_kind");
  const chargeId = objectId(payment.latest_charge);
  if (!chargeId) throw new MarketingSourceError("payment_charge_unavailable", true);
  const charge = await reader.charge(chargeId);
  if (charge.id !== chargeId || objectId(charge.payment_intent) !== payment.id || charge.livemode !== payment.livemode || charge.currency !== payment.currency) throw new MarketingSourceError("charge_payment_mismatch");
  if (!charge.paid || !charge.captured || charge.status !== "succeeded") throw new MarketingSourceError("charge_not_captured", true);
  if (charge.amount_captured !== payment.amount_received) throw new MarketingSourceError("captured_amount_mismatch");
  const transactionId = conversionId("payment", payment.id);
  return {
    paymentIntentId: payment.id,
    chargeId,
    event: {
      schemaVersion: 1,
      eventId: transactionId,
      eventType: "purchase",
      transactionId,
      customerId: conversionId("organization", organizationId),
      // All current Octopus checkout/off-session charges capture automatically.
      // Use the same processor charge timestamp on CS and PI capture paths.
      occurredAt: processorTime(charge.created),
      amountMinor: positiveMinor(payment.amount_received),
      currency: cashCurrency(payment.currency),
      purchaseKind: kinds[0]!,
    },
  };
}

export async function resolveStripeConversion(
  reader: MarketingStripeReader,
  kind: "purchase" | "refund",
  reference: string,
  organizationId: string,
  environment: MarketingConfig["environment"],
): Promise<{ event: ConversionEvent; originalPurchase?: { event: PurchaseEvent; paymentIntentId: string } }> {
  if (kind === "purchase") return { event: (await paymentEvent(reader, reference, organizationId, environment)).event };
  if (!reference.startsWith("re_") && !reference.startsWith("pyr_")) throw new MarketingSourceError("unsupported_refund_reference");
  const refund = await reader.refund(reference);
  if (refund.id !== reference) throw new MarketingSourceError("refund_identity_mismatch");
  if (refund.status !== "succeeded") throw new MarketingSourceError("refund_not_succeeded", refund.status !== "failed" && refund.status !== "canceled");
  const paymentIntentId = objectId(refund.payment_intent);
  if (!paymentIntentId) throw new MarketingSourceError("refund_payment_unavailable");
  const original = await paymentEvent(reader, paymentIntentId, organizationId, environment);
  if (objectId(refund.charge) !== original.chargeId || cashCurrency(refund.currency) !== original.event.currency) throw new MarketingSourceError("refund_payment_mismatch");
  const transactionId = conversionId("refund", refund.id);
  const amountMinor = positiveMinor(refund.amount);
  const occurredAt = processorTime(refund.created);
  if (BigInt(amountMinor) > BigInt(original.event.amountMinor) || occurredAt < original.event.occurredAt) throw new MarketingSourceError("invalid_refund_amount_or_time");
  return {
    event: { schemaVersion: 1, eventId: transactionId, eventType: "refund", transactionId, originalTransactionId: original.event.transactionId, customerId: original.event.customerId, amountMinor, currency: original.event.currency, occurredAt },
    originalPurchase: { event: original.event, paymentIntentId },
  };
}
