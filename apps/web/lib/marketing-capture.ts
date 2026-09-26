import "server-only";
import { randomUUID } from "node:crypto";
import { prisma } from "@octopus/db";
import { conversionId, readMarketingJson } from "./marketing-conversions";
import { enqueueMarketingTracking } from "./marketing-outbox";
import { ATTRIBUTION_COOKIE, VISIT_COOKIE } from "./marketing-consent";
import { parseTrackingPayload, resolveTrackingConfig, TRACKING_MODEL, trackingIdentity, type TrackingConfig, type TrackingRecord } from "./marketing-tracking";
import { MarketingSourceError, resolveStripeConversion, type MarketingStripeReader } from "./marketing-stripe";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MONTH_MS = 30 * 86400_000;
type Visit = Extract<TrackingRecord, { recordType: "visit" }>;

export function activeTrackingConfig(): TrackingConfig | null {
  try {
    const config = resolveTrackingConfig(process.env);
    if (!config || config.trackingFrom > new Date() || (process.env.NODE_ENV === "production" && config.environment !== "live")) return null;
    return config;
  } catch { return null; }
}

/** The cookie is an unguessable pointer to verified, immutable server evidence. */
export async function readMarketingVisit(config: TrackingConfig, cookie: string | null, at = new Date()): Promise<{ id: string; visit: Visit } | null> {
  const tokens = (cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${VISIT_COOKIE}=`));
  if (tokens.length !== 1) return null;
  const token = tokens[0]!.slice(VISIT_COOKIE.length + 1);
  if (!UUID.test(token)) return null;
  const row = await prisma.marketingConversion.findUnique({ where: { sourceId_originKey: { sourceId: config.sourceId, originKey: `tracking:${config.trackingId}:${token}` } } });
  if (!row || row.environment !== config.environment || row.reference !== config.trackingId || row.kind !== "visit" || !row.payload) return null;
  try {
    const visit = parseTrackingPayload(row.payload, config);
    const age = at.getTime() - new Date(visit.occurredAt).getTime();
    return visit.recordType === "visit" && age >= 0 && age <= MONTH_MS ? { id: row.id, visit } : null;
  } catch { return null; }
}

export async function validateMarketingLink(config: TrackingConfig, linkId: string, occurredAt: Date): Promise<boolean> {
  if (!UUID.test(linkId)) return false;
  try {
    const response = await fetch(`https://ads.weezboo.com/api/conversion-tracking/links/${linkId}`, {
      headers: { Authorization: `Bearer ${config.serverKey}` }, credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(2000),
    });
    if (response.status !== 200) { await response.body?.cancel(); return false; }
    const data = await readMarketingJson(response, 4096, 2000) as Record<string, unknown>;
    const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    return !!data && !Array.isArray(data) && Object.keys(data).length === 14 && data.schemaVersion === 1 &&
      data.sourceId === config.sourceId && data.environment === config.environment && data.trackingId === config.trackingId &&
      data.projectId === config.projectId && data.origin === config.origin && data.model === TRACKING_MODEL &&
      typeof data.keyId === "string" && UUID.test(data.keyId) && data.linkId === linkId && data.valid === true && data.reason === null &&
      validDate(data.createdAt) && validDate(data.connectionEpoch) && validDate(data.checkedAt) && Date.parse(data.createdAt as string) <= occurredAt.getTime();
  } catch { return false; }
}

export async function captureMarketingVisit(config: TrackingConfig, data: unknown, cookie: string | null, now = new Date()): Promise<string | null> {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_visit");
  const d = data as Record<string, unknown>;
  if (Object.keys(d).some(k => !["analyticsConsent", "attributionConsent", "sessionId", "campaignLinkId"].includes(k)) ||
    typeof d.analyticsConsent !== "boolean" || typeof d.attributionConsent !== "boolean") throw new Error("invalid_consent");
  if (!d.analyticsConsent || now < config.trackingFrom) return null;
  if (typeof d.sessionId !== "string" || !UUID.test(d.sessionId)) throw new Error("invalid_session");
  if (d.campaignLinkId !== undefined && (typeof d.campaignLinkId !== "string" || !UUID.test(d.campaignLinkId) || !d.attributionConsent)) throw new Error("invalid_link");
  if (typeof d.campaignLinkId === "string" && !await validateMarketingLink(config, d.campaignLinkId, now)) throw new Error("unverified_link");
  const previous = await readMarketingVisit(config, cookie, now);
  const eventId = randomUUID();
  const visit: Visit = {
    schemaVersion: 1, recordType: "visit", eventId, trackingId: config.trackingId, occurredAt: now.toISOString(),
    visitorId: previous?.visit.visitorId ?? trackingIdentity("visitor", config.sourceId, randomUUID()),
    sessionId: trackingIdentity("session", config.sourceId, d.sessionId), origin: config.origin,
    analyticsConsent: "granted", attributionConsent: d.attributionConsent, campaignLinkId: typeof d.campaignLinkId === "string" ? d.campaignLinkId : null,
  };
  await enqueueMarketingTracking(config, JSON.stringify(visit));
  return eventId;
}

/** Best effort for billing/auth: unavailable attribution must never prevent a sale or signup. */
export async function signupMarketingVisit(cookie: string | null): Promise<string | null> {
  try {
    if (!(cookie ?? "").split(";").some(v => v.trim() === `${ATTRIBUTION_COOKIE}=granted`)) return null;
    const config = activeTrackingConfig();
    const record = config ? await readMarketingVisit(config, cookie) : null;
    return record?.visit.attributionConsent ? record.id : null;
  } catch { return null; }
}

export async function beginMarketingPayment(organizationId: string, attemptKey: string, cookie: string | null): Promise<string | null> {
  try {
    const config = activeTrackingConfig();
    if (!config) return null;
    const consent = (cookie ?? "").split(";").some(v => v.trim() === `${ATTRIBUTION_COOKIE}=granted`);
    const record = consent ? await readMarketingVisit(config, cookie) : null;
    const id = conversionId("payment_context", `${config.sourceId}\n${attemptKey}`);
    const row = await prisma.marketingPaymentAttribution.upsert({
      where: { id }, update: {}, create: {
        id, sourceId: config.sourceId, environment: config.environment, trackingId: config.trackingId, organizationId,
        visitorId: record?.visit.attributionConsent ? record.visit.visitorId : null,
      },
    });
    return row.organizationId === organizationId && row.environment === config.environment && row.trackingId === config.trackingId ? row.id : null;
  } catch { return null; }
}

export async function bindMarketingPayment(id: string | null, reference: string, response: unknown): Promise<void> {
  if (!id || !/^(pi|cs)_[A-Za-z0-9_]+$/.test(reference)) return;
  try {
    const lastResponse = (response as { lastResponse?: { headers?: HeadersInit } } | null)?.lastResponse;
    // Stripe documents Idempotent-Replayed for cached responses. Without a first
    // response, withhold association rather than attaching today's visitor to an old sale.
    if (!lastResponse?.headers || new Headers(lastResponse.headers).get("idempotent-replayed") === "true") return;
    await prisma.marketingPaymentAttribution.updateMany({ where: { id, paymentReference: null }, data: { paymentReference: reference } });
  } catch { /* Missing proof remains unattributed; billing continues. */ }
}

/** Independent reconciliation handles either arrival order without altering cash events. */
export async function captureMarketingContexts(config: TrackingConfig, stripe: MarketingStripeReader): Promise<void> {
  const users = await prisma.$queryRaw<Array<{ id: string; createdAt: Date; payload: string }>>`
    SELECT u.id, u."createdAt", v.payload FROM users u
    JOIN marketing_conversions v ON v.id = u."marketingVisitId"
    WHERE u."createdAt" >= ${config.trackingFrom} AND v."sourceId" = ${config.sourceId}
      AND v.environment = ${config.environment} AND v.reference = ${config.trackingId} AND v.kind = 'visit'
      AND v."sourceCreatedAt" >= ${config.trackingFrom}
      AND NOT EXISTS (SELECT 1 FROM marketing_conversions c WHERE c."sourceId" = ${config.sourceId}
        AND c."originKey" = 'signup-context:' || ${config.trackingId} || ':' || u.id)
    ORDER BY u."createdAt", u.id LIMIT 50
  `;
  for (const user of users) {
    const visit = parseTrackingPayload(user.payload, config);
    if (visit.recordType !== "visit" || !visit.attributionConsent || new Date(visit.occurredAt) > user.createdAt || user.createdAt.getTime() - Date.parse(visit.occurredAt) > MONTH_MS) continue;
    const payload = JSON.stringify({ schemaVersion: 1, recordType: "conversion_context", eventId: conversionId("signup_context", `${config.trackingId}:${user.id}`),
      trackingId: config.trackingId, occurredAt: user.createdAt.toISOString(), visitorId: visit.visitorId,
      conversionType: "registration", conversionId: conversionId("user", user.id), attributionConsent: "granted" });
    // Same immutable bytes and stable event id; local marker avoids repeatedly selecting sent users.
    await prisma.marketingConversion.upsert({ where: { sourceId_originKey: { sourceId: config.sourceId, originKey: `signup-context:${config.trackingId}:${user.id}` } }, update: {},
      create: { sourceId: config.sourceId, environment: config.environment, originKey: `signup-context:${config.trackingId}:${user.id}`, kind: "conversion_context", reference: config.trackingId, sourceCreatedAt: user.createdAt, payload } });
  }
  // ponytail: one payment per minute; raise the bounded batch if real throughput requires it.
  const payments = await prisma.marketingPaymentAttribution.findMany({ where: {
    sourceId: config.sourceId, environment: config.environment, trackingId: config.trackingId,
    createdAt: { gte: config.trackingFrom }, visitorId: { not: null }, paymentReference: { not: null }, completedAt: null, nextAttemptAt: { lte: new Date() },
  }, orderBy: { nextAttemptAt: "asc" }, take: 1 });
  for (const payment of payments) {
    try {
      const { event } = await resolveStripeConversion(stripe, "purchase", payment.paymentReference!, payment.organizationId, config.environment);
      // Stripe timestamps have one-second precision. Old idempotent responses cannot acquire a new visitor.
      if (event.eventType !== "purchase" || Date.parse(event.occurredAt) < Math.floor(payment.createdAt.getTime() / 1000) * 1000) {
        throw new MarketingSourceError("payment_predates_initiation");
      }
      await enqueueMarketingTracking(config, JSON.stringify({ schemaVersion: 1, recordType: "conversion_context",
        eventId: conversionId("purchase_context", `${config.trackingId}:${event.transactionId}`), trackingId: config.trackingId,
        occurredAt: event.occurredAt, visitorId: payment.visitorId, conversionType: "purchase", conversionId: event.transactionId, attributionConsent: "granted" }));
      await prisma.marketingPaymentAttribution.update({ where: { id: payment.id }, data: { completedAt: new Date() } });
    } catch (error) {
      await prisma.marketingPaymentAttribution.update({ where: { id: payment.id }, data: error instanceof MarketingSourceError && !error.retryable
        ? { completedAt: new Date() } : { nextAttemptAt: new Date(Date.now() + 300_000) } });
    }
  }
}
