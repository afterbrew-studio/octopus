import type { MarketingStripeReader } from "../../marketing-stripe";

export function fixture() {
  const payment: Awaited<ReturnType<MarketingStripeReader["payment"]>> = {
    id: "pi_fixture", status: "succeeded", amount_received: 14_800, currency: "usd", customer: "cus_fixture",
    metadata: { orgId: "org_fixture", type: "subscription" }, latest_charge: "ch_fixture", livemode: false, capture_method: "automatic",
  };
  const checkout: Awaited<ReturnType<MarketingStripeReader["checkout"]>> = {
    id: "cs_fixture", status: "complete", mode: "payment", payment_status: "paid", payment_intent: payment.id, customer: "cus_fixture",
    metadata: { orgId: "org_fixture", type: "subscription_start" }, livemode: false,
  };
  const charge: Awaited<ReturnType<MarketingStripeReader["charge"]>> = {
    id: "ch_fixture", created: 1_789_344_000, status: "succeeded", paid: true, captured: true,
    amount_captured: 14_800, currency: "usd", payment_intent: payment.id, livemode: false,
  };
  const refund: Awaited<ReturnType<MarketingStripeReader["refund"]>> = {
    id: "re_fixture", created: charge.created + 60, status: "succeeded", amount: 1000, currency: "usd", payment_intent: payment.id, charge: charge.id,
  };
  const reader: MarketingStripeReader = {
    payment: async () => payment,
    checkout: async () => checkout,
    checkoutsForPayment: async () => [checkout],
    charge: async () => charge,
    refund: async () => refund,
  };
  return { reader, payment, checkout, charge, refund };
}
