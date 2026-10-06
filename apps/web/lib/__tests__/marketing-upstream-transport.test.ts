import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeUpstreamTransport, planUpstreamTransport, stripeAuditTransport, type StripeAuditFetch, type UpstreamAuthority } from "../marketing-upstream-transport";
import { runOperator } from "../../scripts/marketing-upstream-transport";
import { cashDigest } from "../marketing-cash-compare";
import { upstreamFixture } from "./fixtures/marketing-upstream";

async function setup() {
  const f = await upstreamFixture();
  const authority: UpstreamAuthority = { expectedPins: structuredClone(f.input.pins), issuedAt: new Date(f.now - 100).toISOString(), expiresAt: new Date(f.now + 60_000).toISOString() };
  const env = { STRIPE_SECRET_KEY: "sk_test_synthetic", UNIFIED_ADS_ENABLED: "true", UNIFIED_ADS_SOURCE_ID: f.input.pins.binding.sourceId, UNIFIED_ADS_ENVIRONMENT: "test", UNIFIED_ADS_SERVER_KEY: `uads_${f.input.pins.binding.keyId}_${"x".repeat(43)}`, UNIFIED_ADS_FROM: f.input.pins.activationFrom, UNIFIED_ADS_CASH_EXPECTED_BINDING: JSON.stringify(f.input.pins.binding) };
  const plan = () => planUpstreamTransport(f.input, authority, "/synthetic/evidence", f.now);
  const run = (send: StripeAuditFetch = (url, init) => { expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("error"); return f.send(new Request(url, init)); }) => executeUpstreamTransport(f.input, authority, "/synthetic/evidence", plan().digest, env, send, () => f.now);
  return { ...f, authority, env, plan, run };
}

describe("explicit upstream real-transport candidate (synthetic IO only)", () => {
  it("plans without credentials or IO, then executes canonical GET audit with separate A/B/C", async () => {
    const f = await setup();
    expect(f.requests).toHaveLength(0);
    expect(JSON.parse(f.plan().body).initialEndpoints).toHaveLength(3);
    const result = await f.run(); const body = JSON.parse(result.body);
    expect(body.members.map((m: { semanticDigest: string }) => m.semanticDigest).sort()).toEqual(f.retained.members.map(m => m.semanticDigest).sort());
    expect([body.A, body.B, body.C]).toEqual(["not_observed", "complete_retained_scope", "unknown"]);
    expect(body.captureAgreement).toBe("matched_for_observed_scope");
    expect(f.requests).toHaveLength(5);
    for (const request of f.requests) {
      expect(request.method).toBe("GET"); expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe("Bearer sk_test_synthetic");
      expect(request.headers.has("cookie") || request.headers.has("origin") || request.headers.has("stripe-account")).toBe(false);
    }
    for (const secret of [f.env.STRIPE_SECRET_KEY, f.env.UNIFIED_ADS_SERVER_KEY, "cus_fixture", "org_fixture"]) expect(result.body + f.plan().body).not.toContain(secret);
  });

  it("fails independent binding, approval, stale inventory and runtime guards before IO", async () => {
    for (const kind of ["expected", "digest", "expired", "stale", "key", "source", "project", "activation", "retained"] as const) {
      const f = await setup(); const approved = f.plan().digest;
      if (kind === "expected") f.authority.expectedPins.accountId = "acct_wrong";
      if (kind === "digest") f.input.pins.predecessorDigest = "a".repeat(64);
      if (kind === "expired") f.authority.expiresAt = new Date(f.now - 1).toISOString();
      if (kind === "key") f.env.STRIPE_SECRET_KEY = "sk_live_wrong";
      if (kind === "source") f.env.UNIFIED_ADS_SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      if (kind === "project") f.env.UNIFIED_ADS_CASH_EXPECTED_BINDING = JSON.stringify({ ...f.input.pins.binding, project: { ...f.input.pins.binding.project, version: 2 } });
      if (kind === "activation") f.env.UNIFIED_ADS_FROM = new Date(f.now).toISOString();
      if (kind === "retained") f.input.retainedBody += " ";
      let tick = f.now;
      if (kind === "stale") { tick += 900_001; f.authority.issuedAt = new Date(tick - 1).toISOString(); f.authority.expiresAt = new Date(tick + 60_000).toISOString(); }
      await expect(executeUpstreamTransport(f.input, f.authority, "/synthetic/evidence", approved, f.env, (url, init) => f.send(new Request(url, init)), () => tick)).rejects.toThrow();
      expect(f.requests).toHaveLength(0);
    }
  });

  it("rejects sealed ambiguity and malformed gaps before any synthetic send", async () => {
    const conflicts = ["alias_content_conflict", "alias_receipt_conflict", "scope_conflict", "ledger_origin_conflict", "payload_scope_conflict", "refund_identity_conflict", "payment_identity_conflict", "dependency_origin_conflict", "invalid_payload", "unsupported_reference"];
    for (const gap of [...conflicts.map(code => ({ code, origin: "outbox_0" })), null, "missing_outbox", { code: ["missing_outbox"], origin: "snapshot" }, { code: "missing_outbox" }, { code: "missing_outbox", origin: 1 }, { code: "unknown", origin: "outbox_0" }, { code: "missing_outbox", origin: "outbox_0", extra: true }]) {
      const f = await setup();
      Object.assign(f.retained, { B: "incomplete", gaps: [gap] }); f.seal();
      f.authority.expectedPins = structuredClone(f.input.pins);
      expect(() => f.plan()).toThrow();
      let sends = 0;
      await expect(executeUpstreamTransport(f.input, f.authority, "/synthetic/evidence", "0".repeat(64), f.env, async () => { sends++; return Response.json({}); }, () => f.now)).rejects.toThrow();
      expect(sends).toBe(0);
    }
  });

  it("rejects conflicting retained evidence even without reported conflict gaps", async () => {
    for (const kind of ["member", "ledger", "outbox", "origin", "alias", "receipt", "scope", "payload", "digest", "identity", "aliases", "gap_state"] as const) {
      const f = await setup();
      if (kind === "member") f.retained.members.push(structuredClone(f.retained.members[0]!));
      if (kind === "ledger") f.retained.ledger.push(structuredClone(f.retained.ledger[0]!));
      if (kind === "outbox") f.retained.outbox.push(structuredClone(f.retained.outbox[0]!));
      if (kind === "origin") f.retained.outbox[0]!.organizationId = "org_wrong";
      if (kind === "alias") f.retained.outbox.push({ ...f.retained.outbox[0]!, id: "outbox_alias", originKey: "ledger:alias", payload: JSON.stringify({ ...JSON.parse(f.retained.outbox[0]!.payload), amountMinor: "1" }) });
      if (kind === "receipt") f.retained.outbox[0]!.receiptId = f.retained.members[1]!.receiptId;
      if (kind === "scope") Object.assign(f.retained.outbox[0]!, { environment: "live" });
      if (kind === "payload") f.retained.outbox[0]!.payload = "{}";
      if (kind === "digest") f.retained.members[0]!.semanticDigest = "a".repeat(64);
      if (kind === "identity") f.retained.members[0]!.businessIdentity = "wrong";
      if (kind === "aliases") Object.assign(f.retained.members[0]!, { aliases: ["outbox_0", "outbox_0"] });
      if (kind === "gap_state") Object.assign(f.retained, { gaps: [{ code: "missing_outbox", origin: "ledger:missing" }] });
      f.seal(); f.authority.expectedPins = structuredClone(f.input.pins);
      expect(() => f.plan()).toThrow();
      let sends = 0;
      await expect(executeUpstreamTransport(f.input, f.authority, "/synthetic/evidence", "0".repeat(64), f.env, async () => { sends++; return Response.json({}); }, () => f.now)).rejects.toThrow();
      expect(sends).toBe(0);
    }
  });

  it("preserves missing capture, ownership and incomplete delivery as gaps", async () => {
    for (const kind of ["missing_outbox", "unresolved_payload", "unresolved_original", "delivery_incomplete", "ownership", "truncated", "unaccounted_retained_origin"] as const) {
      const f = await setup();
      if (kind === "missing_outbox") { f.retained.outbox.splice(0, 1); f.retained.members.splice(0, 1); }
      if (kind === "unresolved_payload") { Object.assign(f.retained.outbox[0]!, { payload: null, status: "pending", receiptId: null }); f.retained.members.splice(0, 1); }
      if (kind === "unresolved_original") { f.retained.outbox.splice(0, 1); f.retained.members.splice(0, 1); }
      if (kind === "delivery_incomplete") { Object.assign(f.retained.outbox[0]!, { status: "pending", receiptId: null }); Object.assign(f.retained.members[0]!, { receiptId: null }); }
      if (kind === "ownership") { f.input.ownership = []; f.input.pins.ownershipDigest = cashDigest("[]"); }
      else Object.assign(f.retained, { B: "incomplete", gaps: [{ code: kind, origin: kind === "unresolved_payload" ? "outbox_0" : "snapshot" }] });
      f.seal(); f.authority.expectedPins = structuredClone(f.input.pins);
      const result = JSON.parse((await f.run()).body);
      expect(f.requests.length).toBeGreaterThan(0);
      expect(result.captureAgreement).toBe("incomplete"); expect(result.C).toBe("unknown");
      expect(result.B).toBe(kind === "ownership" ? "complete_retained_scope" : "incomplete");
      if (kind === "ownership") expect(result.gaps.some((g: { code: string }) => g.code === "ownership_unresolved")).toBe(true);
    }
  });

  it("accepts consistent aliases and the exact older refund original", async () => {
    const f = await setup();
    const from = new Date(f.refund.created * 1000).toISOString();
    f.input.pins.from = f.input.pins.activationFrom = from;
    f.retained.scope.from = f.retained.activationFrom = from;
    f.env.UNIFIED_ADS_FROM = from;
    f.responses["/v1/charges"] = { object: "list", data: [], has_more: false };
    f.retained.ledger.splice(0, 1); f.retained.members[0]!.dependency = true;
    f.retained.outbox.push({ ...f.retained.outbox[0]!, id: "outbox_alias", originKey: `payment:${f.payment.id}`, reference: f.payment.id });
    Object.assign(f.retained.members[0]!, { aliases: ["outbox_0", "outbox_alias"] });
    f.seal(); f.authority.expectedPins = structuredClone(f.input.pins);
    const result = JSON.parse((await f.run()).body);
    expect(result.captureAgreement).toBe("matched_for_observed_scope");
    expect(result.members.find((m: { eventType: string }) => m.eventType === "purchase").dependency).toBe(true);
    expect(f.requests.filter(r => new URL(r.url).pathname === "/v1/charges/ch_fixture")).toHaveLength(1);
  });

  it("denies non-GET, foreign origin, redirects, credentials, headers, query expansion and expired plans", async () => {
    const f = await setup(); let calls = 0;
    const send = async () => { calls++; return Response.json({}); };
    const base = { method: "GET", redirect: "error" as const, credentials: "omit" as const, headers: { Accept: "application/json", "Stripe-Version": f.input.pins.apiVersion } };
    const transport = stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, send, () => f.now);
    const bad = [
      new Request("https://api.stripe.com/v1/account", { ...base, method: "POST" }),
      new Request("https://evil.example/v1/account", base),
      new Request("https://api.stripe.com/v1/account", { ...base, redirect: "follow" }),
      new Request("https://api.stripe.com/v1/account", { ...base, headers: { ...base.headers, Cookie: "synthetic" } }),
      new Request("https://api.stripe.com/v1/account?expand[]=external_accounts", base),
      new Request("https://api.stripe.com/v1/charges?limit=100", base),
      new Request("https://api.stripe.com/v1/checkout/sessions?payment_intent=pi_fixture&limit=2&limit=2", base),
    ];
    for (const r of bad) await expect(transport(r)).rejects.toThrow("upstream_transport_stopped_no_retry");
    const request = new Request("https://api.stripe.com/v1/account", base);
    await expect(stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, send, () => f.now, f.now)(request)).rejects.toThrow();
    expect(calls).toBe(0);
    await expect(stripeAuditTransport(f.input, f.env.STRIPE_SECRET_KEY, async () => { calls++; return new Response(null, { status: 302, headers: { Location: "https://evil.example" } }); })(request)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("keeps rate limits, redirect and ambiguous network failures partial without retry or raw exception leakage", async () => {
    for (const kind of ["rate", "redirect", "network"] as const) {
      const f = await setup(); let calls = 0;
      const result = await f.run(async () => { calls++; if (kind === "network") throw Error("sk_test_PRIVATE_PROVIDER_BODY"); return new Response(null, { status: kind === "rate" ? 429 : 302 }); });
      const p = JSON.parse(result.body);
      expect(calls).toBe(1); expect(p.processorEnumeration).toBe("partial"); expect(p.C).toBe("unknown"); expect(p.captureAgreement).toBe("incomplete");
      expect(result.body).not.toContain("PRIVATE_PROVIDER_BODY");
    }
  });

  it("writes durable intent before IO and refuses a second invocation in the same evidence directory", async () => {
    const f = await setup(); const directory = await mkdtemp(join(tmpdir(), "upstream-operator-"));
    try {
      const inputPath = join(directory, "input.json"), authorityPath = join(directory, "authority.json"), output = join(directory, "evidence");
      await writeFile(inputPath, JSON.stringify(f.input)); await writeFile(authorityPath, JSON.stringify(f.authority));
      let calls = 0;
      const send: StripeAuditFetch = async (url, init) => { calls++; const intent = JSON.parse(await readFile(join(output, "intent.json"), "utf8")); expect(intent.plan.inputDigest).toBeTruthy(); return f.send(new Request(url, init)); };
      const plan = await runOperator(["plan", inputPath, authorityPath, output], {}, send, () => f.now);
      expect(calls).toBe(0);
      await runOperator(["execute", inputPath, authorityPath, output, plan.digest], f.env, send, () => f.now);
      expect(calls).toBe(5);
      const receipt = JSON.parse(await readFile(join(output, "receipt.json"), "utf8")); expect(receipt.planDigest).toBe(plan.digest);
      const result = await readFile(join(output, "result.json"), "utf8"); expect(result).not.toContain(f.env.STRIPE_SECRET_KEY);
      await expect(runOperator(["execute", inputPath, authorityPath, output, plan.digest], f.env, send, () => f.now)).rejects.toThrow();
      expect(calls).toBe(5);
    } finally { await rm(directory, { recursive: true }); }
  });
});
