/**
 * Pure parsing/formatting for the deterministic tool pre-pass (#643). No
 * server-only deps so it is unit-testable; the subprocess runner lives in
 * deterministic-tools.ts and imports from here.
 */

export interface ToolFinding {
  tool: string; // e.g. "semgrep"
  filePath: string;
  line: number;
  ruleId: string;
  severity: "🔴" | "🟠" | "🟡";
  message: string;
}

export interface PrePassFile {
  /** Repo-relative path (used to name the temp file + report location). */
  path: string;
  /** New content of the file (post-change). */
  content: string;
}

export const SEMGREP_SEVERITY: Record<string, ToolFinding["severity"]> = {
  ERROR: "🔴",
  WARNING: "🟠",
  INFO: "🟡",
};

export const MAX_TOOL_FINDINGS = 50;

/** Per-repo opt-in gate. Off unless the repo config explicitly enables it. */
export function toolPrePassEnabled(reviewConfig: { enableToolPrePass?: boolean }): boolean {
  return reviewConfig.enableToolPrePass === true;
}

/**
 * Parse semgrep `--json` stdout into normalized findings. Tolerates malformed
 * input (returns []). `stripPrefix`, when given, is removed from result paths
 * (the temp-dir prefix) so findings report repo-relative locations.
 */
export function parseSemgrepJson(stdout: string, stripPrefix = ""): ToolFinding[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return [];
  }
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];

  const findings: ToolFinding[] = [];
  for (const r of results) {
    const res = r as {
      path?: string;
      start?: { line?: number };
      check_id?: string;
      extra?: { severity?: string; message?: string };
    };
    if (!res.path || typeof res.start?.line !== "number") continue;
    const p = stripPrefix && res.path.startsWith(stripPrefix) ? res.path.slice(stripPrefix.length) : res.path;
    findings.push({
      tool: "semgrep",
      filePath: p,
      line: res.start.line,
      ruleId: res.check_id ?? "semgrep",
      severity: SEMGREP_SEVERITY[(res.extra?.severity ?? "").toUpperCase()] ?? "🟡",
      message: (res.extra?.message ?? "").trim().slice(0, 500),
    });
    if (findings.length >= MAX_TOOL_FINDINGS) break;
  }
  return findings;
}

/**
 * Format tool findings into the {{TOOL_FINDINGS}} ground-truth prompt block.
 * Returns "" when there is nothing to inject.
 */
export function formatToolFindings(findings: ToolFinding[]): string {
  if (findings.length === 0) return "";
  return findings
    .map((f) => `- ${f.severity} [${f.tool}:${f.ruleId}] ${f.filePath}:L${f.line} — ${f.message}`)
    .join("\n");
}
