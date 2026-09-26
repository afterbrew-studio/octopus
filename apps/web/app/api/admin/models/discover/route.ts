import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@octopus/db";
import { isAdminApiAuthorized } from "@/lib/admin-auth";
import { discoverModels } from "@/lib/providers/model-discovery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAdminApiAuthorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (request.nextUrl.searchParams.get("cached") === "1") {
    const row = await prisma.systemConfig.findUnique({ where: { id: "singleton" }, select: { modelDiscovery: true } });
    return NextResponse.json(row?.modelDiscovery ?? { ok: true, checkedAt: null, providers: {} }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json(await discoverModels(request.signal), { headers: { "Cache-Control": "no-store" } });
}
