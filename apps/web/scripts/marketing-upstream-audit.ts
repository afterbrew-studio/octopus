import { open } from "node:fs/promises";
import { auditUpstreamCash, type AuditInput } from "../lib/marketing-upstream-audit";

// Offline transcript driver only. There is deliberately no fetch/SDK fallback.
// stdin: { input: AuditInput, now: ISO timestamp, responses: [{ url, status, body }] }
export async function runTranscript(raw: string) {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("fixture_too_large");
  const v = JSON.parse(raw) as { input: AuditInput; now: string; responses: { url: string; status: number; body: unknown }[] };
  if (v.input.pins.environment !== "test" || !Number.isFinite(Date.parse(v.now)) || !Array.isArray(v.responses) || v.responses.length > 500) throw new Error("invalid_synthetic_fixture");
  let index = 0; let mismatch = false;
  const result = await auditUpstreamCash(v.input, async request => {
    const next = v.responses[index++];
    if (!next || request.method !== "GET" || request.url !== next.url || request.headers.has("authorization") || request.headers.has("cookie") || request.headers.has("origin")) { mismatch = true; throw new Error("transcript_mismatch"); }
    return Response.json(next.body, { status: next.status });
  }, { now: () => Date.parse(v.now) });
  if (mismatch || index !== v.responses.length) throw new Error("unconsumed_transcript");
  return result;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("one_output_path_required");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 8 * 1024 * 1024) throw new Error("fixture_too_large");
      chunks.push(bytes);
    }
    const result = await runTranscript(Buffer.concat(chunks).toString("utf8"));
    const file = await open(process.argv[2]!, "wx", 0o600);
    try { await file.writeFile(result.body); await file.sync(); } finally { await file.close(); }
    console.log(JSON.stringify({ digest: result.digest, evidence: "synthetic_local_retained" }));
  } catch {
    console.error("upstream_audit_failed_no_retry"); process.exitCode = 1;
  }
}
