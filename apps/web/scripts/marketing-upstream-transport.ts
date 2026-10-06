import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { cashAssert } from "../lib/marketing-cash-compare";
import { executeUpstreamTransport, planUpstreamTransport, upstreamRuntimeGuards, type StripeAuditFetch, type UpstreamAuthority } from "../lib/marketing-upstream-transport";
import type { AuditInput } from "../lib/marketing-upstream-audit";

async function readBounded(path: string) {
  const file = await open(path, "r");
  try { cashAssert((await file.stat()).size <= 8 * 1024 * 1024); const raw = await file.readFile("utf8"); cashAssert(Buffer.byteLength(raw) <= 8 * 1024 * 1024); return JSON.parse(raw); }
  finally { await file.close(); }
}
async function exclusive(path: string, body: string) {
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}

async function syncDirectory(path: string) {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/** plan is offline; execute requires the separately reviewed digest and existing runtime environment. */
export async function runOperator(args: string[], env: Record<string, string | undefined>, send: StripeAuditFetch, now = () => Date.now()) {
  const [mode, inputPath, authorityPath, outputPath, approved] = args;
  cashAssert((mode === "plan" && args.length === 4) || (mode === "execute" && args.length === 5));
  cashAssert(inputPath && authorityPath && outputPath && resolve(inputPath) !== resolve(authorityPath));
  const input = await readBounded(inputPath) as AuditInput, authority = await readBounded(authorityPath) as UpstreamAuthority;
  const directory = resolve(outputPath);
  const plan = planUpstreamTransport(input, authority, directory, now());
  if (mode === "plan") return plan;
  cashAssert(approved === plan.digest);
  upstreamRuntimeGuards(input, env);
  // One directory per invocation: even an ambiguous crash leaves an intent and blocks rerun.
  await mkdir(directory, { mode: 0o700 });
  await exclusive(`${directory}/intent.json`, JSON.stringify({ plan: JSON.parse(plan.body), planDigest: plan.digest, invokedAt: new Date(now()).toISOString(), policy: "no retries; reconcile any incomplete directory read-only" }));
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  // Read back the durable intent before the first provider GET.
  cashAssert(JSON.parse(await readFile(`${directory}/intent.json`, "utf8")).planDigest === plan.digest);
  const result = await executeUpstreamTransport(input, authority, directory, approved!, env, send, now);
  await exclusive(`${directory}/result.json`, result.body);
  await exclusive(`${directory}/receipt.json`, JSON.stringify({ digest: result.digest, planDigest: plan.digest, completedAt: new Date(now()).toISOString() }));
  await syncDirectory(directory);
  return { body: JSON.stringify({ digest: result.digest, planDigest: plan.digest }), digest: result.digest };
}

if (import.meta.main) {
  try {
    const result = await runOperator(process.argv.slice(2), process.env, (url, init) => fetch(url, init));
    console.log(result.body);
  } catch {
    console.error("upstream_operator_stopped_no_retry_reconcile_existing_evidence"); process.exitCode = 1;
  }
}
