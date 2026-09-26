import { createRoot } from "react-dom/client";
import { BillingSettings } from "../../../app/(app)/settings/billing/billing-settings";

const fixture = {
  savedCard: new URLSearchParams(location.search).has("enabled"),
  paymentMethodsLoaded: !new URLSearchParams(location.search).has("lookupFailed"),
  saveError: "",
  cardResult: "failure",
  finalizeFails: false,
  saves: [] as Record<string, FormDataEntryValue>[],
  refresh: () => render(),
};
Object.assign(window, { billingFixture: fixture });
const root = createRoot(document.getElementById("root")!);
function render() {
  root.render(<BillingSettings
    canManageBilling orgId="fixture-org" creditBalance={0} freeCreditBalance={0}
    billingEmail={null} monthlySpendLimitUsd={null} stripeCustomerId={null}
    stripePublishableKey="fixture-only" planTier="free" planRenewsAt={null}
    planCancelAtPeriodEnd={false} autoReloadConfig={{ enabled: new URLSearchParams(location.search).has("enabled"), pausedForDurableUpgrade: false, thresholdAmount: 10, reloadAmount: 50 }}
    initialTransactions={[]} totalTransactions={0} monthlySpend={0} monthlyResetLabel="Next month"
    paymentMethodsLoaded={fixture.paymentMethodsLoaded}
    paymentMethods={fixture.savedCard ? [{ brand: "fixture", last4: "0000", expMonth: 1, expYear: 2099 }] : []}
  />);
}
render();
