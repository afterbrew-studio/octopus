import { renderPack, type Rule, type RulePack } from "./types";
import { SECURITY_PACK } from "./security";
import { LANGUAGE_PACKS } from "./languages";

export type { Rule, RulePack } from "./types";
export { SECURITY_PACK } from "./security";
export { LANGUAGE_PACKS } from "./languages";

/** File extension → language pack key. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "typescript", jsx: "typescript",
  mjs: "typescript", cjs: "typescript", mts: "typescript", cts: "typescript",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  java: "java",
  rb: "ruby", rake: "ruby",
};

/** Max language packs to include (keeps the prompt bounded on polyglot PRs). */
const MAX_LANGUAGE_PACKS = 3;

interface FileStat { path: string; changedLines: number }

/** Parse changed file paths + per-file changed-line counts from a unified diff. */
function parseFileStats(diff: string): FileStat[] {
  const stats: FileStat[] = [];
  let current: FileStat | null = null;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      current = { path: fileMatch[1], changedLines: 0 };
      stats.push(current);
      continue;
    }
    if (!current) continue;
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      current.changedLines++;
    }
  }
  return stats;
}

function langOf(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? (EXT_TO_LANG[ext] ?? null) : null;
}

/**
 * Choose the rulepacks to inject for a diff: always the security pack, plus the
 * language packs for the languages actually present, capped to the top
 * MAX_LANGUAGE_PACKS by changed-line count. Deterministic; no I/O.
 * Returns the rendered prompt string ("" only for an empty diff).
 */
export function selectRulePacks(diff: string): string {
  const byLang = new Map<string, number>();
  for (const f of parseFileStats(diff)) {
    const lang = langOf(f.path);
    if (lang && LANGUAGE_PACKS[lang]) byLang.set(lang, (byLang.get(lang) ?? 0) + f.changedLines);
  }

  const topLangs = [...byLang.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LANGUAGE_PACKS)
    .map(([lang]) => lang);

  const packs: RulePack[] = [SECURITY_PACK, ...topLangs.map((l) => LANGUAGE_PACKS[l])];
  return packs.map(renderPack).join("\n\n");
}

/** All rules across every pack — for coverage/self-check tests. */
export function allRules(): Rule[] {
  return [SECURITY_PACK, ...Object.values(LANGUAGE_PACKS)].flatMap((p) => p.rules);
}
