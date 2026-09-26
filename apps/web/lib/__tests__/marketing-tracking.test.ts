import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { deliverTracking, parseTrackingPayload, resolveTrackingConfig, trackingIdentity, TRACKING_MODEL, type TrackingConfig } from "../marketing-tracking";

const config: TrackingConfig = {
  sourceId: randomUUID(), environment: "test", serverKey: `uads_${randomUUID()}_${"x".repeat(43)}`,
  from: new Date("2026-09-15T00:00:00Z"), trackingFrom: new Date("2026-09-17T00:00:00Z"),
  trackingId: randomUUID(), projectId: randomUUID(), origin: "https://octopus-review.ai",
};
const record = {
  schemaVersion: 1, recordType: "visit", eventId: randomUUID(), trackingId: config.trackingId,
  occurredAt: "2026-09-17T12:00:00.000Z", visitorId: trackingIdentity("visitor", config.sourceId, randomUUID()),
  sessionId: trackingIdentity("session", config.sourceId, randomUUID()), origin: config.origin,
  analyticsConsent: "granted", attributionConsent: false, campaignLinkId: null,
};
const body = JSON.stringify(record);
const identity = {
  schemaVersion: 1, sourceId: config.sourceId, environment: config.environment, keyId: randomUUID(),
  trackingId: config.trackingId, projectId: config.projectId, origin: config.origin,
  model: TRACKING_MODEL, recordTypes: ["visit", "conversion_context"],
};
const receipt = { receiptId: randomUUID(), duplicate: false, status: "stored", sourceId: config.sourceId, environment: config.environment, trackingId: config.trackingId };

describe("Unified Ads tracking delivery", () => {
  it("hashes random identities within one source, never across products", () => {
    const id = randomUUID();
    expect(trackingIdentity("visitor", config.sourceId, id)).toBe(trackingIdentity("visitor", config.sourceId, id));
    expect(trackingIdentity("visitor", config.sourceId, id)).not.toBe(trackingIdentity("visitor", randomUUID(), id));
    expect(() => trackingIdentity("visitor", config.sourceId, "email@example.com")).toThrow();
  });
  it("keeps tracking independently disabled and requires all binding/cutoff fields", () => {
    expect(resolveTrackingConfig({})).toBeNull();
    const env = { UNIFIED_ADS_ENABLED: "true", UNIFIED_ADS_TRACKING_ENABLED: "true", UNIFIED_ADS_SOURCE_ID: config.sourceId,
      UNIFIED_ADS_ENVIRONMENT: "test", UNIFIED_ADS_SERVER_KEY: config.serverKey, UNIFIED_ADS_FROM: config.from.toISOString(),
      UNIFIED_ADS_TRACKING_FROM: config.trackingFrom.toISOString(), UNIFIED_ADS_TRACKING_ID: config.trackingId,
      UNIFIED_ADS_PROJECT_ID: config.projectId, UNIFIED_ADS_TRACKING_ORIGIN: config.origin };
    expect(resolveTrackingConfig(env)).toEqual(config);
    for (const field of ["UNIFIED_ADS_TRACKING_FROM", "UNIFIED_ADS_TRACKING_ID", "UNIFIED_ADS_PROJECT_ID", "UNIFIED_ADS_TRACKING_ORIGIN"]) {
      expect(() => resolveTrackingConfig({ ...env, [field]: "" })).toThrow();
    }
    expect(() => resolveTrackingConfig({ ...env, UNIFIED_ADS_TRACKING_FROM: "2026-09-14T00:00:00Z" })).toThrow();
    expect(() => resolveTrackingConfig({ ...env, OCTOPUS_SELF_HOSTED: "true" })).toThrow();
  });
  it("accepts only exact consented record schemas after the activation cutoff", () => {
    expect(parseTrackingPayload(body, config)).toEqual(record);
    for (const patch of [{ analyticsConsent: "denied" }, { campaignLinkId: randomUUID() }, { occurredAt: "2026-09-16T23:59:59.000Z" }, { email: "private" }, { accountId: "untrusted" }, { sessionId: "raw" }]) {
      expect(() => parseTrackingPayload(JSON.stringify({ ...record, ...patch }), config)).toThrow();
    }
    const context = { schemaVersion: 1, recordType: "conversion_context", eventId: randomUUID(), trackingId: config.trackingId,
      occurredAt: record.occurredAt, visitorId: record.visitorId, conversionType: "purchase", conversionId: "payment_canonical", attributionConsent: "granted" };
    expect(parseTrackingPayload(JSON.stringify(context), config)).toEqual(context);
    expect(() => parseTrackingPayload(JSON.stringify({ ...context, conversionType: "refund" }), config)).toThrow();
  });
  it("rejects non-string conversion types before any HTTP request", async () => {
    for (const conversionType of [["purchase"], ["registration"], {}, null, 1, true]) {
      const payload = JSON.stringify({ schemaVersion: 1, recordType: "conversion_context", eventId: randomUUID(),
        trackingId: config.trackingId, occurredAt: record.occurredAt, visitorId: record.visitorId,
        conversionType, conversionId: "payment_canonical", attributionConsent: "granted" });
      expect(() => parseTrackingPayload(payload, config)).toThrow("Invalid conversion context");
      let calls = 0;
      expect(await deliverTracking(config, payload, async () => { calls++; return Response.json(identity); }))
        .toEqual({ kind: "blocked", code: "tracking_payload_invalid" });
      expect(calls).toBe(0);
    }
  });
  it("preflights every attempt and recovers a lost response with identical bytes and receipt", async () => {
    const requests: Request[] = []; const bodies: string[] = [];
    let stored = false;
    const send = async (request: Request) => {
      requests.push(request);
      expect(request.redirect).toBe("error");
      expect(request.headers.has("origin")).toBe(false); expect(request.headers.has("cookie")).toBe(false);
      expect(new URL(request.url).search).toBe("");
      expect(request.headers.get("authorization")).toBe(`Bearer ${config.serverKey}`);
      if (request.method === "GET") return Response.json(identity);
      bodies.push(await request.text());
      if (!stored) { stored = true; throw new Error("lost successful response"); }
      return Response.json({ ...receipt, duplicate: true });
    };
    expect((await deliverTracking(config, body, send)).kind).toBe("retry");
    expect(await deliverTracking(config, body, send)).toEqual({ kind: "delivered", status: 200, receiptId: receipt.receiptId });
    expect(bodies).toEqual([body, body]);
    expect(requests.map(r => r.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(requests[0]!.url).toBe("https://ads.weezboo.com/api/conversion-tracking/identity");
    expect(requests[1]!.url).toBe("https://ads.weezboo.com/api/conversion-tracking");
  });
  for (const [field, wrong] of Object.entries({ schemaVersion: 2, sourceId: randomUUID(), environment: "live", trackingId: randomUUID(),
    projectId: randomUUID(), origin: "https://foreign.example", model: "another-model", recordTypes: ["visit"], keyId: "invalid", unexpected: true })) {
    it(`sends zero POST on wrong ${field}`, async () => {
      const methods: string[] = [];
      expect((await deliverTracking(config, body, async request => {
        methods.push(request.method); return Response.json({ ...identity, [field]: wrong });
      })).kind).toBe("retry");
      expect(methods).toEqual(["GET"]);
    });
  }
  it("rejects preflight failure, malformed JSON, redirects and late identity completion", async () => {
    for (const response of [new Response(null, { status: 302 }), new Response(null, { status: 401 }), new Response("{"), Response.json(null)]) {
      let calls = 0;
      expect((await deliverTracking(config, body, async () => { calls++; return response; })).kind).toBe("retry");
      expect(calls).toBe(1);
    }
    let calls = 0; let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    expect(await deliverTracking(config, body, async () => {
      calls++;
      return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; } }));
    }, 10)).toMatchObject({ kind: "retry", code: "receiver_timeout" });
    stream!.enqueue(new TextEncoder().encode(JSON.stringify(identity))); stream!.close();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });
  it("validates receipt binding and holds permanent conflicts while respecting Retry-After", async () => {
    for (const patch of [{ sourceId: randomUUID() }, { trackingId: randomUUID() }, { environment: "live" }, { duplicate: true }]) {
      expect((await deliverTracking(config, body, async r => r.method === "GET" ? Response.json(identity) : Response.json({ ...receipt, ...patch }, { status: 201 }))).kind).toBe("retry");
    }
    for (const status of [400, 409]) {
      expect(await deliverTracking(config, body, async r => r.method === "GET" ? Response.json(identity) : new Response(null, { status }))).toMatchObject({ kind: "blocked", status });
    }
    expect(await deliverTracking(config, body, async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }))).toMatchObject({ kind: "retry", retryAfterMs: 60000 });
    for (const status of [401, 429, 503]) {
      expect((await deliverTracking(config, body, async r => r.method === "GET" ? Response.json(identity) : new Response(null, { status }))).kind).toBe("retry");
    }
  });
  it("bounds payloads and responses and never emits secret error details", async () => {
    let calls = 0;
    expect((await deliverTracking(config, "x".repeat(4097), async () => { calls++; throw Error(); })).kind).toBe("blocked");
    expect(calls).toBe(0);
    expect((await deliverTracking(config, body, async () => new Response("x".repeat(4097)))).kind).toBe("retry");
    const result = await deliverTracking(config, body, async () => { throw Error(config.serverKey); });
    expect(JSON.stringify(result)).not.toContain(config.serverKey);
  });
});
