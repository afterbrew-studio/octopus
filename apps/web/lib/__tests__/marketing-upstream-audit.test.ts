import { describe, expect, it } from "bun:test";
import { auditUpstreamCash } from "../marketing-upstream-audit";
import { conversionId } from "../marketing-conversions";
import { upstreamFixture } from "./fixtures/marketing-upstream";
import { runTranscript } from "../../scripts/marketing-upstream-audit";

describe("upstream cash audit (synthetic only)", () => {
  it("uses the actual canonical resolver and retains separate A/B/C with GET-only bounded reads", async () => {
    const f = await upstreamFixture();
    const result = await auditUpstreamCash(f.input, f.send, { now: () => f.now });
    const p = JSON.parse(result.body);
    expect(p.captureAgreement).toBe("matched_for_observed_scope");
    expect(p.processorEnumeration).toBe("enumeration_complete_for_declared_scope");
    expect([p.A, p.B, p.C]).toEqual(["not_observed", "complete_retained_scope", "unknown"]);
    expect(p.members.map((m: { semanticDigest: string }) => m.semanticDigest).sort()).toEqual(f.retained.members.map(m => m.semanticDigest).sort());
    expect(p.gaps).toEqual([]);
    expect(f.requests).toHaveLength(5);
    for (const r of f.requests) {
      expect(r.method).toBe("GET"); expect(r.redirect).toBe("error");
      expect([...r.headers.keys()].sort()).toEqual(["accept", "stripe-version"]);
    }
    for (const secret of ["cus_fixture", "org_fixture", "pi_fixture", "acct_fixture"]) expect(result.body).not.toContain(secret);
  });

  it("accounts for a failed charge followed by a successful charge on the same payment", async () => {
    const f = await upstreamFixture();
    const failed = { ...f.charge, id: "ch_failed", created: f.charge.created - 1, status: "failed", paid: false, captured: false, amount_captured: 0 };
    f.responses["/v1/charges"] = { object: "list", data: [failed, f.charge], has_more: false };
    const p = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
    expect(p.captureAgreement).toBe("matched_for_observed_scope");
    expect(p.processorEnumeration).toBe("enumeration_complete_for_declared_scope");
    expect(p.gaps).toEqual([]);
    expect(p.dispositions).toEqual([{ subject: conversionId("audit", failed.id), status: "failed" }]);
    expect(p.members.map((m: { semanticDigest: string }) => m.semanticDigest).sort()).toEqual(f.retained.members.map(m => m.semanticDigest).sort());
    expect(p.C).toBe("unknown");
  });

  it("preserves identity, ownership, customer, mode and successful-capture checks across attempts", async () => {
    for (const code of ["identity_mismatch", "ownership_unresolved", "charge_customer_conflict", "mode_mismatch", "unsupported_multiple_capture"] as const) {
      const f = await upstreamFixture();
      const earlier = { ...f.charge, id: "ch_earlier", created: f.charge.created - 1, status: "failed", paid: false, captured: false, amount_captured: 0 };
      if (code === "identity_mismatch") f.payment.id = "pi_wrong";
      if (code === "ownership_unresolved") f.payment.customer = "cus_wrong";
      if (code === "charge_customer_conflict") earlier.customer = "cus_wrong";
      if (code === "mode_mismatch") earlier.livemode = true;
      if (code === "unsupported_multiple_capture") Object.assign(earlier, { status: "succeeded", paid: true, captured: true, amount_captured: f.charge.amount_captured });
      f.responses["/v1/charges"] = { object: "list", data: [earlier, f.charge], has_more: false };
      const p = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
      expect(p.captureAgreement).toBe("incomplete");
      expect(p.gaps.some((g: { code: string }) => g.code === code)).toBe(true);
      expect(p.dispositions).toEqual([]);
      expect(p.C).toBe("unknown");
    }
  });

  it("rejects authority/digest pins before any read", async () => {
    const f = await upstreamFixture(); f.input.transportBinding.accountId = "acct_wrong";
    await expect(auditUpstreamCash(f.input, f.send)).rejects.toThrow("transport_binding_mismatch");
    expect(f.requests).toHaveLength(0);
  });

  it("keeps a successful cash fact absent from ledger as unresolved activation, never zero", async () => {
    const f = await upstreamFixture(); f.retained.ledger.splice(0, 1); f.seal();
    const p = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
    expect(p.members).toHaveLength(2);
    expect(p.gaps.some((g: { code: string }) => g.code === "missing_ledger_activation_unresolved")).toBe(true);
    expect(p.captureAgreement).toBe("incomplete"); expect(p.C).toBe("unknown");
  });

  it("preserves a pending refund gap and makes its later success a new immutable successor", async () => {
    const f = await upstreamFixture(); f.refund.status = "pending";
    const first = await auditUpstreamCash(f.input, f.send, { now: () => f.now });
    expect(JSON.parse(first.body).gaps.some((g: { code: string }) => g.code === "refund_not_succeeded")).toBe(true);
    f.refund.status = "succeeded"; f.input.pins.predecessorDigest = first.digest;
    const next = await auditUpstreamCash(f.input, f.send, { now: () => f.now + 1 });
    expect(JSON.parse(next.body).pins.predecessorDigest).toBe(first.digest);
    expect(JSON.parse(next.body).captureAgreement).toBe("matched_for_observed_scope");
    expect(next.digest).not.toBe(first.digest);
  });

  it("halts on repeated pages, rate limit and account/mode mismatches without retry", async () => {
    for (const mode of ["duplicate", "rate", "account", "mode"] as const) {
      const f = await upstreamFixture();
      if (mode === "duplicate") f.responses["/v1/charges"] = { object: "list", data: [f.charge], has_more: true };
      if (mode === "account") f.responses["/v1/account"] = { id: "acct_wrong" };
      if (mode === "mode") f.charge.livemode = true;
      let calls = 0;
      const p = JSON.parse((await auditUpstreamCash(f.input, async r => { calls++; return mode === "rate" ? new Response(null, { status: 429 }) : f.send(r); }, { now: () => f.now })).body);
      expect(p.processorEnumeration).toBe("partial"); expect(p.failure).toBeTruthy();
      expect(calls).toBeLessThanOrEqual(3);
    }
  });

  it("does not equate unsupported ownership, currency or manual capture with no cash", async () => {
    for (const mode of ["owner", "currency", "manual", "alias", "receipt"] as const) {
      const f = await upstreamFixture();
      if (mode === "owner") f.payment.metadata.orgId = "org_other";
      if (mode === "currency") f.payment.currency = f.charge.currency = f.refund.currency = "eur";
      if (mode === "manual") f.payment.capture_method = "manual";
      if (mode === "alias") f.checkout.metadata.type = "subscription_start";
      if (mode === "receipt") { f.retained.outbox[0]!.receiptId = "invalid"; f.seal(); }
      const p = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
      expect(p.captureAgreement).toBe("incomplete"); expect(p.gaps.length).toBeGreaterThan(0); expect(p.C).toBe("unknown");
    }
  });

  it("enforces ten-page and overall bounds, never treating a truncated list as complete", async () => {
    const f = await upstreamFixture(); let pages = 0;
    const p = JSON.parse((await auditUpstreamCash(f.input, async r => {
      if (new URL(r.url).pathname === "/v1/charges") return Response.json({ object: "list", data: [{ ...f.charge, id: `ch_page${++pages}` }], has_more: true });
      return f.send(r);
    }, { now: () => f.now })).body);
    expect(p.failure).toBe("page_limit"); expect(pages).toBe(10); expect(p.processorEnumeration).toBe("partial");
    let tick = f.now;
    const late = JSON.parse((await auditUpstreamCash(f.input, async r => { const response = await f.send(r); tick += 300_001; return response; }, { now: () => tick })).body);
    expect(late.failure).toBe("overall_deadline"); expect(late.reads).toHaveLength(1);
  });

  it("aborts a hanging read without retry", async () => {
    const f = await upstreamFixture(); let calls = 0; let aborted = false;
    const p = JSON.parse((await auditUpstreamCash(f.input, r => { calls++; r.signal.addEventListener("abort", () => { aborted = true; }); return new Promise<Response>(() => {}); }, { now: () => f.now })).body);
    expect(p.failure).toBe("request_deadline"); expect(calls).toBe(1); expect(aborted).toBe(true);
  }, 15_000);

  it("caps total reads at 500 even across exact failed-refund parent reads", async () => {
    const f = await upstreamFixture(); let calls = 0;
    const refunds = Array.from({ length: 600 }, (_, i) => ({ ...f.refund, id: `re_${i}`, charge: `ch_${i}`, status: "failed" }));
    const p = JSON.parse((await auditUpstreamCash(f.input, async r => {
      calls++; const u = new URL(r.url);
      if (u.pathname === "/v1/refunds") {
        const start = u.searchParams.has("starting_after") ? Number(u.searchParams.get("starting_after")!.slice(3)) + 1 : 0;
        return Response.json({ object: "list", data: refunds.slice(start, start + 100), has_more: start + 100 < refunds.length });
      }
      if (u.pathname === "/v1/charges") return Response.json({ object: "list", data: [], has_more: false });
      if (u.pathname.startsWith("/v1/charges/")) return Response.json({ ...f.charge, id: u.pathname.split("/").at(-1)! });
      return f.send(r);
    }, { now: () => f.now })).body);
    expect(calls).toBe(500); expect(p.failure).toBe("read_limit"); expect(p.processorEnumeration).toBe("partial");
  });

  it("caps filtered Checkout list pages and rejects unexpected pins before reads", async () => {
    const f = await upstreamFixture(); let checkoutPages = 0;
    const charges = Array.from({ length: 11 }, (_, i) => ({ ...f.charge, id: `ch_${i}`, payment_intent: `pi_${i}` }));
    const p = JSON.parse((await auditUpstreamCash(f.input, async r => {
      const u = new URL(r.url);
      if (u.pathname === "/v1/charges") return Response.json({ object: "list", data: charges, has_more: false });
      if (u.pathname === "/v1/refunds") return Response.json({ object: "list", data: [], has_more: false });
      if (u.pathname === "/v1/checkout/sessions") { checkoutPages++; return Response.json({ object: "list", data: [], has_more: false }); }
      if (u.pathname.startsWith("/v1/payment_intents/")) { const id = u.pathname.split("/").at(-1)!; return Response.json({ ...f.payment, id, latest_charge: `ch_${id.slice(3)}` }); }
      return f.send(r);
    }, { now: () => f.now })).body);
    expect(checkoutPages).toBe(10); expect(p.failure).toBe("page_limit");
    for (const target of [f.input.pins, f.input.pins.binding, f.input.pins.binding.project]) {
      Object.assign(target, { unexpectedField: "synthetic-private-sentinel" });
      let reads = 0;
      await expect(auditUpstreamCash(f.input, async r => { reads++; return f.send(r); }, { now: () => f.now })).rejects.toThrow();
      expect(reads).toBe(0); Reflect.deleteProperty(target, "unexpectedField");
    }
    const good = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
    expect(good.retainedObservation).toEqual(f.retained.producerObservation);
  });

  it("reads only the exact pre-interval original needed by a refund", async () => {
    const f = await upstreamFixture();
    const from = new Date(f.refund.created * 1000).toISOString();
    f.input.pins.from = f.input.pins.activationFrom = from;
    f.retained.scope.from = f.retained.activationFrom = from;
    f.responses["/v1/charges"] = { object: "list", data: [], has_more: false };
    f.retained.ledger.splice(0, 1); f.retained.members[0]!.dependency = true; f.seal();
    const p = JSON.parse((await auditUpstreamCash(f.input, f.send, { now: () => f.now })).body);
    expect(p.captureAgreement).toBe("matched_for_observed_scope");
    expect(p.members.find((m: { eventType: string }) => m.eventType === "purchase").dependency).toBe(true);
    expect(f.requests.filter(r => new URL(r.url).pathname === "/v1/charges/ch_fixture")).toHaveLength(1);
    expect(f.requests.filter(r => new URL(r.url).pathname === "/v1/charges")).toHaveLength(1);
  });

  it("runs exact offline transcripts and rejects a mismatched oracle outside the audit catch", async () => {
    const f = await upstreamFixture();
    const responses: { url: string; status: number; body: unknown }[] = [];
    await auditUpstreamCash(f.input, async r => { const response = await f.send(r); responses.push({ url: r.url, status: response.status, body: await response.clone().json() }); return response; }, { now: () => f.now });
    const v = { input: f.input, now: new Date(f.now).toISOString(), responses };
    expect(JSON.parse((await runTranscript(JSON.stringify(v))).body).captureAgreement).toBe("matched_for_observed_scope");
    responses[4]!.url += "?wrong=true";
    await expect(runTranscript(JSON.stringify(v))).rejects.toThrow("unconsumed_transcript");
  });
});
