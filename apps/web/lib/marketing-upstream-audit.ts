import { cashDigest, cashObject, cashTime, type CashBinding } from "./marketing-cash-compare";
import { normalizeMarketingCash } from "./marketing-cash-contract";
import { conversionId, readMarketingJson, serializeConversion, type ConversionEvent } from "./marketing-conversions";
import { MarketingSourceError, resolveStripeConversion, type MarketingStripeReader } from "./marketing-stripe";

export const UPSTREAM_LIMITS = { pageSize: 100, pagesPerEndpoint: 10, reads: 500, requestMs: 10_000, overallMs: 300_000 } as const;
export const UPSTREAM_API_VERSION = "2026-06-24.dahlia";
type Json = Record<string, unknown>;
type Normalized = ReturnType<typeof normalizeMarketingCash>;
export type AuditPins = {
  accountId: string; environment: "test" | "live"; apiVersion: string;
  activationFrom: string; from: string; to: string; binding: CashBinding;
  ownershipDigest: string; retainedDigest: string; predecessorDigest: string | null;
};
export type AuditInput = {
  pins: AuditPins;
  /** Independently retained transport/credential scope, not inferred from object results. */
  transportBinding: { accountId: string; environment: "test" | "live"; apiVersion: string };
  ownership: { orgId: string; customerId: string }[];
  /** Exact sealed retained-cash/v1 body. No database is opened by this audit. */
  retainedBody: string;
};
type AuditTransport = (request: Request) => Promise<Response>;
class AuditStop extends Error { constructor(readonly code: string) { super(code); } }
function check(ok: unknown, code = "invalid_input"): asserts ok { if (!ok) throw new AuditStop(code); }
function obj(v: unknown): Json { check(v && typeof v === "object" && !Array.isArray(v), "invalid_object"); return v as Json; }
function text(v: unknown): string { check(typeof v === "string" && v.length > 0 && v.length <= 256, "invalid_field"); return v; }
function id(v: unknown): string { const s = text(typeof v === "object" && v ? obj(v).id : v); check(/^[A-Za-z][A-Za-z0-9_]*$/.test(s), "invalid_identity"); return s; }
function time(v: unknown): number { check(Number.isSafeInteger(v) && Number(v) > 0, "invalid_time"); return Number(v); }
const digest = (v: unknown) => cashDigest(JSON.stringify(v));
const opaque = (v: string) => conversionId("audit", v);
function metadata(v: unknown) { const m = obj(v); return { ...(m.orgId ? { orgId: id(m.orgId) } : {}), ...(m.type ? { type: text(m.type) } : {}) }; }
function project(kind: "payment" | "checkout" | "charge" | "refund", value: unknown): Json {
  const v = obj(value); const result: Json = { id: id(v.id) };
  const fields = kind === "payment" ? ["status", "amount_received", "currency", "customer", "latest_charge", "livemode", "capture_method"]
    : kind === "checkout" ? ["status", "mode", "payment_status", "payment_intent", "customer", "livemode"]
      : kind === "charge" ? ["created", "status", "paid", "captured", "amount_captured", "currency", "payment_intent", "livemode", "customer"]
        : ["created", "status", "amount", "currency", "payment_intent", "charge"];
  for (const f of fields) {
    const x = v[f];
    if (["customer", "latest_charge", "payment_intent", "charge"].includes(f)) result[f] = x == null ? null : id(x);
    else if (["livemode", "paid", "captured"].includes(f)) { check(typeof x === "boolean", "invalid_field"); result[f] = x; }
    else if (["amount_received", "amount_captured", "amount"].includes(f)) { check(Number.isSafeInteger(x) && Number(x) >= 0, "invalid_amount"); result[f] = x; }
    else if (f === "created") result[f] = time(x);
    else {
      result[f] = text(x);
      if (f === "currency") check(/^[a-z]{3}$/.test(String(x)), "invalid_currency");
      if (f === "status") check((kind === "payment" ? ["requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded"] : kind === "checkout" ? ["open", "complete", "expired"] : kind === "charge" ? ["succeeded", "pending", "failed"] : ["pending", "requires_action", "succeeded", "failed", "canceled"]).includes(String(x)), "invalid_status");
      if (f === "mode") check(["payment", "setup", "subscription"].includes(String(x)), "invalid_mode");
      if (f === "payment_status") check(["paid", "unpaid", "no_payment_required"].includes(String(x)), "invalid_status");
      if (f === "capture_method") check(["automatic", "automatic_async", "manual"].includes(String(x)), "invalid_capture_method");
    }
  }
  if (kind === "payment" || kind === "checkout") result.metadata = metadata(v.metadata);
  return result;
}
function sanitized(v: Json): Json {
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k,
    ["id", "customer", "latest_charge", "payment_intent", "charge"].includes(k) && typeof x === "string" ? opaque(x)
      : k === "metadata" ? { owner: obj(x).orgId ? opaque(String(obj(x).orgId)) : null, type: ["credit_purchase", "auto_reload", "subscription_start", "subscription"].includes(String(obj(x).type)) ? obj(x).type : null } : x]));
}

/** Pure preflight shared by the offline planner and injected audit. */
export function validateUpstreamInput(input: AuditInput, start: number) {
  cashObject(input, ["pins", "transportBinding", "ownership", "retainedBody"]);
  const { pins: p } = input;
  cashObject(p, ["accountId", "environment", "apiVersion", "activationFrom", "from", "to", "binding", "ownershipDigest", "retainedDigest", "predecessorDigest"]);
  cashObject(p.binding, ["sourceId", "environment", "keyId", "capabilities", "project"]);
  cashObject(p.binding.project, ["projectId", "version"]);
  cashObject(input.transportBinding, ["accountId", "environment", "apiVersion"]);
  check(p.apiVersion === UPSTREAM_API_VERSION && /^acct_[A-Za-z0-9]+$/.test(p.accountId));
  check(["test", "live"].includes(p.environment) && p.binding.environment === p.environment);
  check(cashTime(p.activationFrom) <= cashTime(p.from) && p.from < cashTime(p.to) && Date.parse(p.to) <= start);
  check(input.transportBinding.accountId === p.accountId && input.transportBinding.environment === p.environment && input.transportBinding.apiVersion === p.apiVersion, "transport_binding_mismatch");
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  check(uuid.test(p.binding.sourceId) && uuid.test(p.binding.keyId) && uuid.test(p.binding.project.projectId) && Number.isSafeInteger(p.binding.project.version) && p.binding.project.version > 0);
  check(Array.isArray(p.binding.capabilities) && p.binding.capabilities.every(c => ["purchases", "refunds", "registrations", "trials", "credit_balance"].includes(c)) && new Set(p.binding.capabilities).size === p.binding.capabilities.length && ["purchases", "refunds"].every(c => p.binding.capabilities.includes(c)));
  check(p.predecessorDigest === null || /^[0-9a-f]{64}$/.test(p.predecessorDigest));
  check(input.ownership.length <= 1000 && input.ownership.every(o => cashObject(o, ["orgId", "customerId"]) && id(o.orgId) && id(o.customerId)));
  check(new Set(input.ownership.map(o => o.orgId)).size === input.ownership.length && new Set(input.ownership.map(o => o.customerId)).size === input.ownership.length);
  check(digest(input.ownership) === p.ownershipDigest && Buffer.byteLength(input.retainedBody) <= 4 * 1024 * 1024 && cashDigest(input.retainedBody) === p.retainedDigest);
  const retained = obj(JSON.parse(input.retainedBody));
  check(retained.schemaVersion === 1 && retained.captureContract === "retained-cash/v1" && retained.C === "unknown" && retained.normalizationContract === "unified-ads/conversion-event-semantic/v1");
  const retainedObservation = cashObject(retained.producerObservation, ["startedAt", "completedAt"]);
  check(cashTime(retainedObservation.startedAt) <= cashTime(retainedObservation.completedAt) && cashTime(retainedObservation.completedAt) >= p.to && Date.parse(String(retainedObservation.completedAt)) <= start, "retained_time_mismatch");
  check(digest(retained.binding) === digest(p.binding) && retained.activationFrom === p.activationFrom && digest(retained.scope) === digest({ from: p.from, to: p.to }), "retained_binding_mismatch");
  check(["complete_retained_scope", "incomplete"].includes(String(retained.B)) && Array.isArray(retained.gaps) && Array.isArray(retained.ledger) && Array.isArray(retained.members) && Array.isArray(retained.outbox));
  const ledger = retained.ledger.map(obj), stored = retained.members.map(obj), outbox = retained.outbox.map(obj);
  check(ledger.length <= 1000 && stored.length <= 2000 && outbox.length <= 2000);
  return { retained, retainedObservation, ledger, stored, outbox, uuid };
}

/** Explicit, injected GET-only audit. No ambient fetch, credentials, DB, capture or receiver client. */
export async function auditUpstreamCash(input: AuditInput, send: AuditTransport, clock = { now: () => Date.now() }) {
  const start = clock.now();
  const { retained, retainedObservation, ledger, stored, outbox, uuid } = validateUpstreamInput(input, start);
  const p = input.pins;
  const gaps: { code: string; subject: string }[] = [];
  const gap = (code: string, subject: string) => gaps.push({ code, subject: opaque(subject) });
  const reads: { requestDigest: string; startedAt: string; completedAt: string; status: number | null; requestId: string | null }[] = [];
  const pages: { endpoint: string; page: number; cursor: string | null; count: number; hasMore: boolean; projectionDigest: string }[] = [];
  const objects = new Map<string, Json>();
  const sessions = new Map<string, Json[]>();
  let checkoutPages = 0;
  const dispositions: { subject: string; status: string }[] = [];
  let lastClock = start;
  const now = () => { const n = clock.now(); check(n >= lastClock, "clock_regressed"); lastClock = n; return n; };
  const iso = () => new Date(now()).toISOString();
  async function get(path: string, params: Record<string, string> = {}) {
    check(reads.length < UPSTREAM_LIMITS.reads, "read_limit");
    const remaining = UPSTREAM_LIMITS.overallMs - (now() - start); check(remaining > 0, "overall_deadline");
    const url = new URL(path, "https://api.stripe.com");
    check(url.origin === "https://api.stripe.com" && /^\/v1\/(account|charges(?:\/[A-Za-z0-9_]+)?|refunds(?:\/[A-Za-z0-9_]+)?|payment_intents\/[A-Za-z0-9_]+|checkout\/sessions)$/.test(url.pathname), "invalid_endpoint");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const evidence = { requestDigest: cashDigest(`GET ${url.href}`), startedAt: iso(), completedAt: "", status: null as number | null, requestId: null as string | null };
    reads.push(evidence);
    const control = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { control.abort(); reject(new AuditStop("request_deadline")); }, Math.min(UPSTREAM_LIMITS.requestMs, remaining)); });
      const operation = async () => {
        const response = await send(new Request(url, { method: "GET", redirect: "error", credentials: "omit", signal: control.signal, headers: { Accept: "application/json", "Stripe-Version": p.apiVersion } }));
        check(!control.signal.aborted, "request_deadline");
        evidence.status = response.status;
        const requestId = response.headers.get("request-id");
        evidence.requestId = requestId && /^req_[A-Za-z0-9]{1,128}$/.test(requestId) ? requestId : null;
        check(!response.headers.has("set-cookie") && (!response.headers.has("stripe-version") || response.headers.get("stripe-version") === p.apiVersion), "response_binding_mismatch");
        check(response.status === 200, response.status === 429 ? "rate_limited" : "provider_read_failed");
        const result = await readMarketingJson(response, 1024 * 1024, Math.min(UPSTREAM_LIMITS.requestMs, remaining));
        check(!control.signal.aborted && now() - start < UPSTREAM_LIMITS.overallMs, "overall_deadline");
        return result;
      };
      return await Promise.race([operation(), deadline]);
    } catch (e) { throw e instanceof AuditStop ? e : new AuditStop("provider_read_failed"); }
    finally { if (timer) clearTimeout(timer); control.abort(); evidence.completedAt = new Date(clock.now()).toISOString(); }
  }
  function remember(kind: "payment" | "checkout" | "charge" | "refund", raw: unknown) {
    const v = project(kind, raw), key = `${kind}:${v.id}`, previous = objects.get(key);
    check(!previous || digest(previous) === digest(v), "conflicting_object");
    if (kind !== "refund") check(v.livemode === (p.environment === "live"), "mode_mismatch");
    objects.set(key, v); return v;
  }
  async function retrieve(kind: "payment" | "charge" | "refund", reference: string) {
    id(reference); check((kind === "payment" ? /^pi_/ : kind === "charge" ? /^(ch_|py_)/ : /^(re_|pyr_)/).test(reference), "unsupported_reference");
    const cached = objects.get(`${kind}:${reference}`); if (cached) return cached;
    const v = remember(kind, await get(`/v1/${kind === "payment" ? "payment_intents" : `${kind}s`}/${reference}`));
    check(v.id === reference, "identity_mismatch"); return v;
  }
  async function checkouts(payment: string) {
    if (sessions.has(payment)) return sessions.get(payment)!;
    check(checkoutPages < UPSTREAM_LIMITS.pagesPerEndpoint, "page_limit");
    checkoutPages++;
    const page = obj(await get("/v1/checkout/sessions", { payment_intent: id(payment), limit: "2" }));
    check(page.object === "list" && Array.isArray(page.data) && typeof page.has_more === "boolean", "invalid_page");
    check(!page.has_more && page.data.length <= 1, "ambiguous_checkout");
    const result = page.data.map(v => remember("checkout", v));
    pages.push({ endpoint: "checkout/sessions", page: checkoutPages, cursor: null, count: result.length, hasMore: page.has_more, projectionDigest: digest(result.map(sanitized)) });
    sessions.set(payment, result); return result;
  }
  const reader: MarketingStripeReader = {
    payment: async r => await retrieve("payment", r) as Awaited<ReturnType<MarketingStripeReader["payment"]>>,
    charge: async r => await retrieve("charge", r) as Awaited<ReturnType<MarketingStripeReader["charge"]>>,
    refund: async r => await retrieve("refund", r) as Awaited<ReturnType<MarketingStripeReader["refund"]>>,
    checkoutsForPayment: async r => await checkouts(r) as Awaited<ReturnType<MarketingStripeReader["checkoutsForPayment"]>>,
    checkout: async r => { const v = objects.get(`checkout:${r}`); check(v, "unretained_checkout"); return v as Awaited<ReturnType<MarketingStripeReader["checkout"]>>; },
  };
  const candidates: { kind: "charge" | "refund"; id: string }[] = [];
  const exhausted = { charges: false, refunds: false };
  const members = new Map<string, Normalized & { body: string; dependency: boolean; receiptId: string | null; aliases: string[] }>();
  async function enumerate(kind: "charge" | "refund") {
    let cursor: string | null = null; const seen = new Set<string>();
    for (let pageNumber = 1; pageNumber <= UPSTREAM_LIMITS.pagesPerEndpoint; pageNumber++) {
      const query: Record<string, string> = { "created[gte]": String(Math.floor(Date.parse(p.from) / 1000)), "created[lt]": String(Math.ceil(Date.parse(p.to) / 1000)), limit: "100" };
      if (cursor) query.starting_after = cursor;
      const page = obj(await get(`/v1/${kind}s`, query));
      check(page.object === "list" && Array.isArray(page.data) && typeof page.has_more === "boolean" && page.data.length <= 100 && (!page.has_more || page.data.length > 0), "invalid_page");
      const projected = page.data.map(v => remember(kind, v));
      for (const v of projected) {
        check(Number(v.created) >= Number(query["created[gte]"]) && Number(v.created) < Number(query["created[lt]"]), "page_scope_mismatch");
        const reference = String(v.id); check(!seen.has(reference), "pagination_duplicate"); seen.add(reference);
        const when = new Date(Number(v.created) * 1000).toISOString();
        if (when >= p.from && when < p.to) candidates.push({ kind, id: reference });
        else dispositions.push({ subject: opaque(reference), status: "outside_exact_interval" });
      }
      pages.push({ endpoint: `${kind}s`, page: pageNumber, cursor: cursor ? opaque(cursor) : null, count: projected.length, hasMore: page.has_more, projectionDigest: digest(projected.map(sanitized)) });
      if (!page.has_more) { exhausted[`${kind}s`] = true; return; }
      cursor = String(projected.at(-1)!.id);
    }
    throw new AuditStop("page_limit");
  }
  function retain(event: ConversionEvent, refs: string[], dependency: boolean, orgId: string) {
    const body = serializeConversion(event); const n = normalizeMarketingCash(body);
    const previous = members.get(n.businessIdentity); check(!previous || previous.semanticDigest === n.semanticDigest, "canonical_conflict");
    const matches = ledger.filter(l => l.organizationId === orgId && (n.eventType === "refund" || ["purchase", "auto_reload", "subscription"].includes(String(l.type))) && refs.includes(String(n.eventType === "refund" ? l.stripeRefundId : l.stripeSessionId)));
    if (!dependency && !matches.length) gap("missing_ledger_activation_unresolved", n.transactionId);
    if (!dependency && matches.some(l => cashTime(l.createdAt) < p.activationFrom)) gap("pre_activation_ledger", n.transactionId);
    const known = stored.filter(s => s.businessIdentity === n.businessIdentity);
    if (!known.length) gap(dependency ? "missing_original_evidence" : "missing_retained_member", n.transactionId);
    if (known.length > 1 || known.some(s => s.semanticDigest !== n.semanticDigest)) gap("retained_content_conflict", n.transactionId);
    const aliases = matches.map(l => opaque(String(l.id)));
    for (const l of matches) {
      const rows = outbox.filter(o => o.originKey === `ledger:${l.id}`);
      if (!rows.length) gap("missing_outbox", n.transactionId);
      for (const row of rows) {
        if (row.organizationId !== orgId || row.sourceCreatedAt !== l.createdAt || row.reference !== (l.stripeRefundId ?? l.stripeSessionId)) gap("ledger_origin_conflict", n.transactionId);
        try { check(normalizeMarketingCash(String(row.payload)).semanticDigest === n.semanticDigest); } catch { gap("outbox_payload_conflict", n.transactionId); }
        if (row.status === "delivered" && (typeof row.receiptId !== "string" || !uuid.test(row.receiptId) || ![200, 201].includes(Number(row.httpStatus)) || known.length !== 1 || row.receiptId !== known[0]!.receiptId)) gap("delivery_receipt_conflict", n.transactionId);
        if (row.status !== "delivered") gap(`delivery_${["pending", "processing", "blocked"].includes(String(row.status)) ? row.status : "unknown"}`, n.transactionId);
      }
    }
    const receipt = known.length === 1 && known[0]!.semanticDigest === n.semanticDigest && typeof known[0]!.receiptId === "string" && uuid.test(known[0]!.receiptId) ? known[0]!.receiptId as string : null;
    members.set(n.businessIdentity, { ...n, body, dependency: previous ? previous.dependency && dependency : dependency, receiptId: receipt, aliases: [...new Set([...(previous?.aliases ?? []), ...aliases])].sort() });
  }
  let failure: string | null = null;
  try {
    check(obj(await get("/v1/account")).id === p.accountId, "account_mismatch");
    await enumerate("charge"); await enumerate("refund");
    for (const candidate of candidates) {
      const v = objects.get(`${candidate.kind}:${candidate.id}`)!;
      try {
        const paymentId = id(v.payment_intent), payment = await retrieve("payment", paymentId), cs = await checkouts(paymentId);
        const owners = [obj(payment.metadata).orgId, ...cs.map(s => obj(s.metadata).orgId)].filter(Boolean);
        const owner = input.ownership.find(o => owners.length > 0 && owners.every(x => x === o.orgId) && payment.customer === o.customerId);
        check(owner, "ownership_unresolved");
        for (const s of cs) check(s.payment_intent === paymentId && s.customer === owner.customerId && s.mode === "payment", "checkout_ownership_conflict");
        const charge = candidate.kind === "charge" ? v : await retrieve("charge", id(v.charge));
        check(charge.customer === owner.customerId, "charge_customer_conflict");
        if (["failed", "canceled"].includes(String(v.status))) { dispositions.push({ subject: opaque(candidate.id), status: String(v.status) }); continue; }
        check(payment.latest_charge === charge.id, "unsupported_multiple_capture");
        const result = await resolveStripeConversion(reader, candidate.kind === "charge" ? "purchase" : "refund", candidate.kind === "charge" ? paymentId : candidate.id, owner.orgId, p.environment);
        const original = result.originalPurchase?.event ?? result.event;
        for (const session of cs) {
          const alias = await resolveStripeConversion(reader, "purchase", String(session.id), owner.orgId, p.environment);
          check(normalizeMarketingCash(serializeConversion(alias.event)).semanticDigest === normalizeMarketingCash(serializeConversion(original)).semanticDigest, "checkout_alias_conflict");
        }
        if (candidate.kind === "charge") check(result.event.occurredAt === new Date(Number(v.created) * 1000).toISOString(), "charge_occurrence_conflict");
        retain(result.event, candidate.kind === "charge" ? [paymentId, ...cs.map(s => String(s.id))] : [candidate.id], false, owner.orgId);
        if (result.originalPurchase) retain(result.originalPurchase.event, [paymentId, ...cs.map(s => String(s.id))], result.originalPurchase.event.occurredAt < p.from || result.originalPurchase.event.occurredAt >= p.to, owner.orgId);
      } catch (e) {
        if (e instanceof AuditStop && ["page_limit", "read_limit", "overall_deadline", "clock_regressed", "request_deadline", "provider_read_failed", "rate_limited", "response_binding_mismatch", "conflicting_object", "mode_mismatch", "invalid_page", "identity_mismatch"].includes(e.code)) throw e;
        gap(e instanceof MarketingSourceError || e instanceof AuditStop ? e.code : "unsupported_object", candidate.id);
      }
    }
    check(now() - start < UPSTREAM_LIMITS.overallMs, "overall_deadline");
  } catch (e) { failure = e instanceof AuditStop ? e.code : "invalid_provider_evidence"; gap(failure, "enumeration"); }
  for (const s of stored) if (!members.has(String(s.businessIdentity))) gap("retained_member_not_observed_upstream", String(s.transactionId));
  const packet = {
    schemaVersion: 1, contract: "upstream-cash-audit/v1", evidence: "local_retained_not_database_immutable",
    pins: { ...p, accountId: opaque(p.accountId) }, limits: UPSTREAM_LIMITS,
    retainedObservation,
    observation: { startedAt: new Date(start).toISOString(), completedAt: new Date(clock.now()).toISOString() },
    A: "not_observed", B: retained.B, C: "unknown",
    processorEnumeration: exhausted.charges && exhausted.refunds && !failure ? "enumeration_complete_for_declared_scope" : "partial",
    captureAgreement: !gaps.length && retained.B === "complete_retained_scope" && !(retained.gaps as unknown[]).length ? "matched_for_observed_scope" : "incomplete",
    failure, exhausted, reads, pages, projections: [...objects.values()].map(sanitized), dispositions, gaps,
    members: [...members.values()].sort((a, b) => a.businessIdentity.localeCompare(b.businessIdentity)),
    limitations: ["synthetic transport requires separately authorized real acceptance", "operator supplied transport mode binding", "per-read knowledge, not an atomic processor snapshot", "retained B does not cover upstream omissions", "late facts require an explicit successor", "no customer-zero, QA reclassification or learning admission", "no complete lifetime refund or settlement inventory"],
  };
  const body = JSON.stringify(packet); check(Buffer.byteLength(body) <= 4 * 1024 * 1024, "packet_limit");
  return { body, digest: cashDigest(body) };
}
