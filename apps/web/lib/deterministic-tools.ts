import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSemgrepJson, type PrePassFile, type ToolFinding } from "./deterministic-tools-parse";

export { toolPrePassEnabled, formatToolFindings, filterToChangedLines, type ToolFinding, type PrePassFile } from "./deterministic-tools-parse";

const execFileAsync = promisify(execFile);

/**
 * Opt-in, default-OFF deterministic pre-pass (#643). Runs a curated semgrep
 * ruleset on the changed files BEFORE the LLM review and feeds the results in as
 * ground-truth (semgrep findings are not hallucinated and cost ~0 LLM tokens).
 *
 * Security posture (this executes a subprocess on user code, so it is locked
 * down hard):
 *   - OFF unless the repo explicitly opts in (reviewConfig.enableToolPrePass).
 *   - Binary-gated: no-op if `semgrep` is not on PATH, so shipping this without
 *     the binary in the image changes NOTHING in production.
 *   - execFile (never a shell) with an argv array — no command interpolation.
 *   - Runs against a throwaway temp dir of ONLY the changed files, never a repo
 *     checkout; paths are contained; the dir is always removed.
 *   - Minimal env, `--metrics=off`, local ruleset only (no registry) → no network.
 *   - Hard timeout + stdout cap; ANY failure returns [] so the review still runs.
 */

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_STDOUT_BYTES = 5_000_000; // 5MB cap on tool output
const MAX_FILES = 200; // don't materialize an unbounded number of files

// Minimal env for EVERY semgrep invocation (version probe + scan): never inherit
// the process env, so no secrets reach the subprocess. Cast past the app's
// augmented ProcessEnv type.
const MINIMAL_ENV = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), SEMGREP_SEND_METRICS: "off" } as unknown as NodeJS.ProcessEnv;

/** True when `semgrep` is available on PATH. Cached per process. */
let semgrepAvailable: boolean | null = null;
async function hasSemgrep(): Promise<boolean> {
  if (semgrepAvailable !== null) return semgrepAvailable;
  try {
    await execFileAsync("semgrep", ["--version"], { timeout: 5_000, env: MINIMAL_ENV });
    semgrepAvailable = true;
  } catch {
    semgrepAvailable = false;
  }
  return semgrepAvailable;
}

/**
 * Run the semgrep pre-pass on the changed files. Returns normalized findings, or
 * [] on any failure / when the binary is absent. `rulesPath` is a LOCAL ruleset
 * file bundled in the repo (no registry → no network).
 */
export async function runSemgrepPrePass(
  files: PrePassFile[],
  rulesPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<ToolFinding[]> {
  if (files.length === 0 || files.length > MAX_FILES) return [];
  if (!(await hasSemgrep())) return [];

  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "octo-semgrep-"));
    for (const f of files) {
      // Contain every path inside tmpDir — never write outside it.
      const safeRel = path.normalize(f.path).replace(/^(\.\.(\/|\\|$))+/, "");
      const dest = path.join(tmpDir, safeRel);
      if (!dest.startsWith(tmpDir + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content, "utf-8");
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const { stdout } = await execFileAsync(
      "semgrep",
      [
        "scan",
        "--config", rulesPath,
        "--json",
        "--quiet",
        "--metrics=off",
        "--disable-version-check",
        "--timeout", String(Math.floor(timeoutMs / 1000)),
        tmpDir,
      ],
      {
        timeout: timeoutMs,
        maxBuffer: MAX_STDOUT_BYTES,
        env: MINIMAL_ENV,
      },
    );

    return parseSemgrepJson(stdout, tmpDir + path.sep);
  } catch {
    // Semgrep exits 0 even when it has findings (we don't pass --error), so a
    // throw here means a real failure (missing binary, timeout, bad rules) —
    // degrade to [] and let the LLM review proceed.
    return [];
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
