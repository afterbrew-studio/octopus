import { NextRequest, NextResponse } from "next/server";
import { isAdminApiAuthorized } from "@/lib/admin-auth";
import { mergeOrgs } from "@/lib/merge-orgs";

// Vendor admin machine endpoint: consolidate one organization into another.
// Guarded by the shared ADMIN_API_SECRET bearer (inert on self-host). Driven by
// octopus-deploy's merge-orgs-wdc.yml over loopback, mirroring seed-docs.
//
// dryRun defaults to TRUE: the caller MUST pass dryRun:false explicitly to
// commit, so an accidental call can never mutate data.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!isAdminApiAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const sourceOrgId = typeof body.sourceOrgId === "string" ? body.sourceOrgId : "";
  const targetOrgId = typeof body.targetOrgId === "string" ? body.targetOrgId : "";
  if (!sourceOrgId || !targetOrgId) {
    return NextResponse.json(
      { error: "sourceOrgId and targetOrgId are required" },
      { status: 400 },
    );
  }

  try {
    const report = await mergeOrgs({
      sourceOrgId,
      targetOrgId,
      newName: typeof body.newName === "string" ? body.newName : undefined,
      newSlug: typeof body.newSlug === "string" ? body.newSlug : undefined,
      revokeSourceTokens: body.revokeSourceTokens === false ? false : true,
      // Safe default: only commit when the caller explicitly says dryRun:false.
      dryRun: body.dryRun !== false,
    });
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
