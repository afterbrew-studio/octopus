import { afterAll, expect, it, mock } from "bun:test";
import { NextRequest } from "next/server";
import { middleware } from "../../../middleware";

mock.module("server-only", () => ({}));
let captures = 0;
mock.module("@/lib/marketing-capture", () => ({
  activeTrackingConfig: () => ({ origin: server.url.origin, sourceId: "test-source" }),
  captureMarketingVisit: async () => { captures++; return "test-visit"; },
}));
mock.module("@/lib/rate-limit", () => ({
  fixedWindowLimit: async () => ({ ok: true }),
  tooManyRequests: () => new Response(null, { status: 429 }),
}));
const { GET, POST } = await import("../../../app/api/marketing/visit/route");
// Real HTTP, middleware, and route handlers; capture persistence is simulated.
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const routed = middleware(new NextRequest(request));
    if (routed.headers.get("x-middleware-next") !== "1") return routed;
    if (new URL(request.url).pathname !== "/api/marketing/visit") return new Response(null, { status: 404 });
    return request.method === "GET" ? GET() : POST(request);
  },
});
afterAll(() => server.stop(true));

it("returns activation JSON to an anonymous visitor", async () => {
  const response = await fetch(new URL("/api/marketing/visit", server.url), { redirect: "manual" });
  expect(response.status).toBe(200);
  expect(response.headers.get("location")).toBeNull();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ enabled: true });
});

it("admits anonymous POST through middleware and keeps handler guards", async () => {
  const post = (origin: string, contentType: string) => fetch(new URL("/api/marketing/visit", server.url), {
    method: "POST", redirect: "manual", headers: { origin, "content-type": contentType },
    body: JSON.stringify({ analyticsConsent: true, attributionConsent: false }),
  });
  expect((await post("https://foreign.test", "application/json")).status).toBe(403);
  expect((await post(server.url.origin, "text/plain")).status).toBe(415);
  expect(captures).toBe(0);
  const response = await post(server.url.origin, "application/json");
  expect(response.status).toBe(204);
  expect(response.headers.get("set-cookie")).toContain("test-visit");
  expect(captures).toBe(1);
});

it("does not expose neighboring marketing routes or private pages", async () => {
  for (const path of ["/api/marketing/visits", "/api/marketing/visit/private", "/api/marketing/private", "/dashboard"]) {
    const response = await fetch(new URL(path, server.url), { redirect: "manual" });
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  }
});
