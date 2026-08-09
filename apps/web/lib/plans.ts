/**
 * Monthly subscription plans. Charged as off-session PaymentIntents against
 * the org's saved card (same machinery as auto-reload) — deliberately NOT
 * Stripe Billing subscriptions; see renewDueSubscriptions in subscription.ts.
 * Each period grants non-expiring credits into the unified balance; the
 * credit grant exceeds the price so subscribing beats one-off top-ups.
 */
export const SUBSCRIPTION_PLANS = {
  pro: { name: "Pro", priceUsd: 49, creditsUsd: 54 },
  team: { name: "Team", priceUsd: 99, creditsUsd: 115 },
} as const;

export type PaidPlanTier = keyof typeof SUBSCRIPTION_PLANS;

export function isPaidPlanTier(tier: string): tier is PaidPlanTier {
  return tier in SUBSCRIPTION_PLANS;
}

/**
 * Volume bonus on one-off credit top-ups: pay $N, get bonus credits on top.
 * Promotional rates (buy more, get more) — buying $100 lands $150 in credit.
 * These sit ABOVE the subscription per-dollar bonus, so top-ups are the
 * headline deal; all tiers stay margin-positive at the current PLATFORM_MARKUP.
 * Highest matching tier wins.
 */
export const VOLUME_BONUS_TIERS = [
  { minUsd: 500, rate: 0.7 },
  { minUsd: 250, rate: 0.6 },
  { minUsd: 100, rate: 0.5 },
] as const;

/** Bonus credits (USD, rounded to cents) granted for a top-up of `amountUsd`. */
export function volumeBonusUsd(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return 0;
  const tier = VOLUME_BONUS_TIERS.find((t) => amountUsd >= t.minUsd);
  if (!tier) return 0;
  return Math.round(amountUsd * tier.rate * 100) / 100;
}

/**
 * CreditTransaction types that represent a real payment and so get a
 * downloadable invoice/receipt PDF. Shared by the invoice route (server) and
 * the billing UI (client) — kept here (no pdfkit dep) so both can import it.
 */
export const INVOICEABLE_TXN_TYPES = ["purchase", "auto_reload", "subscription"];
