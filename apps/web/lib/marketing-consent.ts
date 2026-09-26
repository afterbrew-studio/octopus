export const ATTRIBUTION_COOKIE = "__Host-octopus_attribution";
export const VISIT_COOKIE = "__Host-octopus_visit";
export const CONSENT_STORAGE = "octopus-consent-v1";
export const SESSION_STORAGE = "octopus-analytics-session-v1";
export type MarketingConsent = { analytics: boolean; attribution: boolean };

export function parseMarketingConsent(value: string | null): MarketingConsent | null {
  try {
    const data = JSON.parse(value ?? "null");
    return data && Object.keys(data).length === 2 && typeof data.analytics === "boolean" && typeof data.attribution === "boolean"
      ? { analytics: data.analytics, attribution: data.attribution } : null;
  } catch { return null; }
}
