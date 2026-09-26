import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { isAdminApiAuthorized } from "@/lib/admin-auth";
import { readMarketingJson, resolveMarketingConfig } from "@/lib/marketing-conversions";
import { cashAssert, cashBinding, cashObject } from "@/lib/marketing-cash-compare";
import { compareCashInventory, createCashInventory, getCashObservation } from "@/lib/marketing-cash-observation";

/** Explicit operator operation only; no schedule, browser UI, capture or delivery side effects. */
export async function POST(request: NextRequest) {
  const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  if (!isAdminApiAuthorized(request)) return respond({ error: "Unauthorized" }, 401);
  if (request.nextUrl.search || request.headers.get("content-type")?.split(";")[0] !== "application/json") return respond({ error: "Invalid request" }, 400);
  let input: Record<string, unknown>;
  try {
    const raw = await readMarketingJson(request, 2048, 2000); cashAssert(raw && typeof raw === "object" && !Array.isArray(raw)); input = raw as Record<string, unknown>;
    cashAssert(["snapshot", "compare", "read"].includes(String(input.operation)));
    cashObject(input, input.operation === "snapshot" ? ["operation", "from", "to", "predecessor"] : ["operation", "id"]);
    if (input.operation === "snapshot") cashAssert(typeof input.from === "string" && typeof input.to === "string" && (input.predecessor === null || typeof input.predecessor === "string"));
    else cashAssert(typeof input.id === "string");
  } catch { return respond({ error: "Invalid request" }, 400); }
  try {
    const config = resolveMarketingConfig(process.env);
    if (!config || (process.env.NODE_ENV === "production" && config.environment !== "live")) return respond({ error: "Source unavailable" }, 409);
    const binding = cashBinding(config, process.env.UNIFIED_ADS_CASH_EXPECTED_BINDING);
    if (input.operation === "read") return respond(await getCashObservation(config, input.id as string));
    if (input.operation === "compare") return respond(await compareCashInventory(config, binding, input.id as string), 201);
    return respond(await createCashInventory(config, binding, { from: input.from as string, to: input.to as string }, input.predecessor as string | null), 201);
  } catch { return respond({ error: "Cash observation unavailable; no business state changed" }, 503); }
}
