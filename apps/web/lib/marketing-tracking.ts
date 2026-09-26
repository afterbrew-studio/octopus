import { createHash } from "node:crypto";
import { deliverMarketingRecord, resolveMarketingConfig, type MarketingConfig, type DeliveryResult } from "./marketing-conversions";

export const TRACKING_MODEL = "last-tagged-visit-30d-v1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_BYTES = 4096;
export interface TrackingConfig extends MarketingConfig {
  trackingId: string;
  projectId: string;
  origin: string;
  trackingFrom: Date;
}

type Base = { schemaVersion: 1; eventId: string; trackingId: string; occurredAt: string; visitorId: string };
export type TrackingRecord = Base & ({
  recordType: "visit"; sessionId: string; origin: string; analyticsConsent: "granted";
  attributionConsent: boolean; campaignLinkId: string | null;
} | {
  recordType: "conversion_context"; conversionType: "registration" | "purchase";
  conversionId: string; attributionConsent: "granted";
});

export function resolveTrackingConfig(env: Record<string, string | undefined>): TrackingConfig | null {
  if (!env.UNIFIED_ADS_TRACKING_ENABLED || env.UNIFIED_ADS_TRACKING_ENABLED === "false") return null;
  if (env.UNIFIED_ADS_TRACKING_ENABLED !== "true") throw new Error("Invalid tracking activation flag");
  const base = resolveMarketingConfig(env);
  if (!base) throw new Error("Tracking requires the existing business-event source configuration");
  const trackingId = env.UNIFIED_ADS_TRACKING_ID ?? "";
  const projectId = env.UNIFIED_ADS_PROJECT_ID ?? "";
  const origin = env.UNIFIED_ADS_TRACKING_ORIGIN ?? "";
  const rawFrom = (env.UNIFIED_ADS_TRACKING_FROM ?? "").replace(/(?<=:\d{2})Z$/, ".000Z");
  const trackingFrom = new Date(rawFrom);
  if (!UUID.test(trackingId) || !UUID.test(projectId)) throw new Error("Invalid tracking binding");
  // Hosted product origin is fixed; a configurable arbitrary origin would
  // permit accidental cross-product collection. Tests use this same binding.
  if (origin !== "https://octopus-review.ai") throw new Error("Invalid tracking origin");
  if (!Number.isFinite(trackingFrom.getTime()) || trackingFrom.toISOString() !== rawFrom || trackingFrom < base.from) {
    throw new Error("Tracking needs an explicit UTC cutoff no earlier than business-event activation");
  }
  return { ...base, trackingId, projectId, origin, trackingFrom };
}

/** Input is a cryptographically random browser/session UUID, never a personal identifier. */
export function trackingIdentity(kind: "visitor" | "session", sourceId: string, randomId: string): string {
  if (!UUID.test(sourceId) || !UUID.test(randomId)) throw new Error("Invalid random tracking identity");
  return `${kind}_${createHash("sha256").update(`octopus-tracking-v1\n${sourceId}\n${kind}\n${randomId}`).digest("hex")}`;
}

/** Validate persisted bytes without reserializing or moving their occurrence time. */
export function parseTrackingPayload(body: string, config: TrackingConfig): TrackingRecord {
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Tracking payload too large");
  const value: unknown = JSON.parse(body);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid tracking payload");
  const d = value as Record<string, unknown>;
  const common = ["schemaVersion", "eventId", "trackingId", "occurredAt", "visitorId", "recordType"];
  const at = typeof d.occurredAt === "string" ? new Date(d.occurredAt) : new Date(NaN);
  if (d.schemaVersion !== 1 || d.trackingId !== config.trackingId ||
      typeof d.eventId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(d.eventId) ||
      typeof d.visitorId !== "string" || !/^visitor_[a-f0-9]{64}$/.test(d.visitorId) ||
      !Number.isFinite(at.getTime()) || at.toISOString() !== d.occurredAt || at < config.trackingFrom) {
    throw new Error("Invalid tracking record identity");
  }
  let fields: string[];
  if (d.recordType === "visit") {
    fields = [...common, "sessionId", "origin", "analyticsConsent", "attributionConsent", "campaignLinkId"];
    if (typeof d.sessionId !== "string" || !/^session_[a-f0-9]{64}$/.test(d.sessionId) || d.origin !== config.origin ||
        d.analyticsConsent !== "granted" || typeof d.attributionConsent !== "boolean" ||
        !(d.campaignLinkId === null || typeof d.campaignLinkId === "string" && UUID.test(d.campaignLinkId) && d.attributionConsent)) {
      throw new Error("Invalid visit consent or binding");
    }
  } else if (d.recordType === "conversion_context") {
    fields = [...common, "conversionType", "conversionId", "attributionConsent"];
    if ((d.conversionType !== "registration" && d.conversionType !== "purchase") || d.attributionConsent !== "granted" ||
        typeof d.conversionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(d.conversionId)) {
      throw new Error("Invalid conversion context");
    }
  } else throw new Error("Invalid tracking record type");
  if (Object.keys(d).length !== fields.length || fields.some(k => !Object.hasOwn(d, k))) throw new Error("Invalid tracking fields");
  return d as TrackingRecord;
}

export async function deliverTracking(
  config: TrackingConfig,
  body: string,
  send?: (request: Request) => Promise<Response>,
  timeoutMs = 10_000,
): Promise<DeliveryResult> {
  // Snapshot configuration before asynchronous I/O (including key rotation).
  const binding = { ...config };
  try { parseTrackingPayload(body, binding); } catch { return { kind: "blocked", code: "tracking_payload_invalid" }; }
  return deliverMarketingRecord(binding, body, {
    path: "conversion-tracking", maxBytes: MAX_BYTES,
    identity: d => Object.keys(d).length === 9 && d.schemaVersion === 1 &&
      d.sourceId === binding.sourceId && d.environment === binding.environment &&
      typeof d.keyId === "string" && UUID.test(d.keyId) &&
      d.trackingId === binding.trackingId && d.projectId === binding.projectId &&
      d.origin === binding.origin && d.model === TRACKING_MODEL &&
      Array.isArray(d.recordTypes) && d.recordTypes.length === 2 &&
      ["visit", "conversion_context"].every(t => (d.recordTypes as unknown[]).includes(t)),
    receipt: d => Object.keys(d).length === 6 && d.sourceId === binding.sourceId &&
      d.environment === binding.environment && d.trackingId === binding.trackingId,
  }, send, timeoutMs);
}
