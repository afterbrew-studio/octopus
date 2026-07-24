/**
 * Curated review-time rulepacks (PR-reviewed TS, no DB — same pattern as
 * knowledge-templates). A rule is a terse, high-signal anti-pattern the reviewer
 * should actively hunt, with a concrete signal + one fix example. Security rules
 * carry CWE/OWASP taxonomy so findings can be tagged. Pure data + pure render so
 * dispatch is deterministic and unit-testable.
 */
export interface Rule {
  /** Stable id, e.g. "sec-sqli" or "ts-floating-promise". */
  id: string;
  cwe?: string; // e.g. "CWE-89"
  owasp?: string; // e.g. "A03:2021-Injection"
  title: string;
  /** What to look for in the diff — the trigger. */
  signal: string;
  /** Languages this rule applies to; "*" for language-agnostic (security). */
  languages: string[];
  severityHint: "🔴" | "🟠" | "🟡";
  remediation: string;
  example: string;
}

export interface RulePack {
  /** Language key ("security" for the always-on pack). */
  key: string;
  title: string;
  rules: Rule[];
}

/** Render one rule as a terse prompt line. */
export function renderRule(r: Rule): string {
  const tax = [r.cwe, r.owasp].filter(Boolean).join(", ");
  const taxStr = tax ? ` (${tax})` : "";
  return `- [${r.severityHint} ${r.id}]${taxStr} ${r.title} — ${r.signal} Fix: ${r.remediation} e.g. ${r.example}`;
}

/** Render a pack as a titled block. */
export function renderPack(pack: RulePack): string {
  return `### ${pack.title}\n${pack.rules.map(renderRule).join("\n")}`;
}
