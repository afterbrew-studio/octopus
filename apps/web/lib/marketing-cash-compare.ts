import { createHash } from "node:crypto";
import { readMarketingJson, type MarketingConfig } from "./marketing-conversions";

export type CashBinding = { sourceId: string; environment: "test" | "live"; keyId: string; capabilities: string[]; project: { projectId: string; version: number } };
export type CashMember = { eventType: "purchase" | "refund"; transactionId: string; semanticDigest: string; receiptId: string | null };
export const cashDigest = (body: string) => createHash("sha256").update(body).digest("hex");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPABILITIES = ["purchases", "refunds", "registrations", "trials", "credit_balance"];
export function cashAssert(condition: unknown): asserts condition { if (!condition) throw new Error("cash_observation_invalid"); }
export function cashObject(value: unknown, keys: string[]): Record<string, unknown> {
  cashAssert(value && typeof value === "object" && !Array.isArray(value));
  cashAssert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
  return value as Record<string, unknown>;
}
export function cashTime(value: unknown): string {
  cashAssert(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  return value;
}
/** Owner-controlled setup expectation. Never derive project/version from a receiver response. */
export function cashBinding(config: MarketingConfig, raw: string | undefined): CashBinding {
  cashAssert(raw && raw.length <= 2048);
  const v = cashObject(JSON.parse(raw), ["sourceId", "environment", "keyId", "capabilities", "project"]);
  cashAssert(v.sourceId === config.sourceId && v.environment === config.environment && typeof v.keyId === "string" && UUID.test(v.keyId));
  cashAssert(config.serverKey.startsWith(`uads_${v.keyId}_`));
  cashAssert(Array.isArray(v.capabilities) && v.capabilities.every(c => typeof c === "string" && CAPABILITIES.includes(c)) && new Set(v.capabilities).size === v.capabilities.length && ["purchases", "refunds"].every(c => (v.capabilities as string[]).includes(c)));
  const p = cashObject(v.project, ["projectId", "version"]);
  cashAssert(typeof p.projectId === "string" && UUID.test(p.projectId) && Number.isSafeInteger(p.version) && Number(p.version) > 0);
  return { sourceId: config.sourceId, environment: config.environment, keyId: v.keyId, capabilities: [...v.capabilities].sort(), project: { projectId: p.projectId, version: Number(p.version) } };
}
function authority(v: Record<string, unknown>, expected: CashBinding) {
  cashAssert(v.schemaVersion === 1 && v.sourceId === expected.sourceId && v.environment === expected.environment && v.keyId === expected.keyId);
  cashAssert(Array.isArray(v.capabilities) && v.capabilities.every(c => typeof c === "string") && JSON.stringify([...v.capabilities].sort()) === JSON.stringify(expected.capabilities));
}
export function validateCashComparison(input: unknown, expected: CashBinding, entries: CashMember[]) {
  const v = cashObject(input, ["schemaVersion", "sourceId", "environment", "keyId", "capabilities", "project", "observation", "entries"]);
  authority(v, expected);
  const p = cashObject(v.project, ["projectId", "version"]);
  cashAssert(p.projectId === expected.project.projectId && p.version === expected.project.version);
  const o = cashObject(v.observation, ["startedAt", "completedAt"]);
  cashAssert(cashTime(o.startedAt) <= cashTime(o.completedAt));
  cashAssert(Array.isArray(v.entries) && v.entries.length === entries.length);
  v.entries.forEach((entry, i) => {
    const r = cashObject(entry, ["eventType", "transactionId", "status", "receiptId", "receivedAt"]);
    cashAssert(r.eventType === entries[i]!.eventType && r.transactionId === entries[i]!.transactionId);
    if (r.status === "matched") {
      cashAssert(typeof r.receiptId === "string" && UUID.test(r.receiptId)); cashTime(r.receivedAt);
      cashAssert(entries[i]!.receiptId === null || entries[i]!.receiptId === r.receiptId);
    } else cashAssert(["missing", "content_mismatch", "receipt_mismatch"].includes(String(r.status)) && r.receiptId === null && r.receivedAt === null);
  });
  return v;
}
/** No retries or mutation. The injectable transport supports isolated tests without changing destination authority. */
export async function compareCashBatch(config: MarketingConfig, expected: CashBinding, entries: CashMember[], send: typeof fetch = fetch) {
  cashBinding(config, JSON.stringify(expected));
  cashAssert(entries.length > 0 && entries.length <= 32 && new Set(entries.map(e => JSON.stringify([e.eventType, e.transactionId]))).size === entries.length);
  const body = JSON.stringify({ schemaVersion: 1, entries }); cashAssert(Buffer.byteLength(body) <= 16384);
  const endpoint = "https://ads.weezboo.com/api/conversion-events";
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const base = { redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const, signal: controller.signal };
    const identityResponse = await send(new Request(`${endpoint}/identity`, { ...base, headers: { Authorization: `Bearer ${config.serverKey}` } }));
    cashAssert(identityResponse.status === 200 && !controller.signal.aborted);
    const identity = cashObject(await readMarketingJson(identityResponse, 16384, 15000), ["schemaVersion", "sourceId", "environment", "keyId", "capabilities"]); authority(identity, expected);
    cashAssert(!controller.signal.aborted);
    const response = await send(new Request(`${endpoint}/receipts/compare`, { ...base, method: "POST", headers: { Authorization: `Bearer ${config.serverKey}`, "Content-Type": "application/json" }, body }));
    cashAssert(response.status === 200 && !controller.signal.aborted && !response.headers.has("set-cookie"));
    // Read bounded bytes before parsing to retain the actual wire digest.
    const reader = response.body?.getReader(); cashAssert(reader); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.length; cashAssert(size <= 16384 && !controller.signal.aborted); chunks.push(part.value); }
    cashAssert(!controller.signal.aborted);
    const raw = Buffer.concat(chunks).toString("utf8");
    const observation = validateCashComparison(JSON.parse(raw), expected, entries);
    return { request: { schemaVersion: 1, entries }, requestDigest: cashDigest(body), response: observation, responseDigest: cashDigest(raw), identity };
  } finally { clearTimeout(timer); controller.abort(); }
}
