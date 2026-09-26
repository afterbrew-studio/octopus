import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { isAdminApiAuthorized } from "@/lib/admin-auth";
import { readMarketingJson, resolveMarketingConfig } from "@/lib/marketing-conversions";
import { previewMarketingRefundRetry, retryMarketingRefund } from "@/lib/marketing-refund-retry";
import { MarketingSourceError } from "@/lib/marketing-stripe";

type Context = { params: Promise<{ id: string }> };

async function handle(request: NextRequest, context: Context, retry: boolean) {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!isAdminApiAuthorized(request)) return respond({ error: "Unauthorized" }, 401);
  try {
    const { id } = await context.params;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || request.nextUrl.search) return respond({ error: "Invalid request" }, 400);
    const config = resolveMarketingConfig(process.env);
    if (!config || (process.env.NODE_ENV === "production" && config.environment !== "live")) return respond({ error: "Marketing source unavailable" }, 409);
    if (!retry) return respond(await previewMarketingRefundRetry(id, config));
    let input: unknown;
    try { input = await readMarketingJson(request, 1024, 2000); } catch { return respond({ error: "Invalid request" }, 400); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 ||
        !("previewHash" in input) || typeof input.previewHash !== "string" || !/^[0-9a-f]{64}$/.test(input.previewHash)) {
      return respond({ error: "Invalid request" }, 400);
    }
    return respond(await retryMarketingRefund(id, input.previewHash, config), 202);
  } catch (error) {
    if (error instanceof MarketingSourceError) return respond({ error: error.code }, 409);
    // Provider/DB details may include credentials or customer data.
    return respond({ error: "Refund retry unavailable; read a fresh preview before proceeding" }, 503);
  }
}

export const GET = (request: NextRequest, context: Context) => handle(request, context, false);
export const POST = (request: NextRequest, context: Context) => handle(request, context, true);
