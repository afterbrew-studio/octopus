import "server-only";
import { activeTrackingConfig, captureMarketingVisit } from "@/lib/marketing-capture";
import { readMarketingJson } from "@/lib/marketing-conversions";
import { VISIT_COOKIE } from "@/lib/marketing-consent";
import { fixedWindowLimit, tooManyRequests } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ enabled: activeTrackingConfig() !== null }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const config = activeTrackingConfig();
  if (!config) return new Response(null, { status: 204 });
  // Behind the HTTPS proxy, Next's request URL uses its internal listen address.
  if (request.headers.get("origin") !== config.origin || request.headers.get("host") !== new URL(config.origin).host || new URL(request.url).search) {
    return new Response(null, { status: 403 });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return new Response(null, { status: 415 });
  // ponytail: one source-wide budget; add per-consented-visitor limits if traffic warrants it.
  const limit = await fixedWindowLimit(`marketing-visits:${config.sourceId}`, 600, 60, true);
  if (!limit.ok) return tooManyRequests("Visit collection temporarily unavailable", limit.retryAfterSeconds);
  const clear = `${VISIT_COOKIE}=; Path=/; Secure; SameSite=Lax; Max-Age=0`;
  try {
    const data = await readMarketingJson(request, 512, 2000);
    const eventId = await captureMarketingVisit(config, data, request.headers.get("cookie"));
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "Set-Cookie": eventId
      ? `${VISIT_COOKIE}=${eventId}; Path=/; Secure; SameSite=Lax; Max-Age=2592000` : clear } });
  } catch {
    return new Response(null, { status: 400, headers: { "Cache-Control": "no-store", "Set-Cookie": clear } });
  }
}
