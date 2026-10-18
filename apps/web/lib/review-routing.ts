/**
 * Heuristic diff classification + model tier resolution in front of
 * getReviewModel. Trivial/mechanical diffs (lockfile bumps, generated files,
 * docs/tests-only, tiny single-file edits) downshift to a cheaper model; the
 * default (Sonnet) is used for everything else. A deeper model for
 * complex/high-risk diffs is deferred to a plan-gated follow-up — this only ever
 * LOWERS cost, never risks quality by downshifting a substantive change.
 *
 * classifyDiff is pure/deterministic (unit-tested). resolveReviewModel keeps the
 * existing precedence (explicit override / repo pin / org pin win first) and is
 * self-protecting: it never emits a model that has no pricing (which would bill
 * $0), falling back to the default instead.
 */
import type { ReviewCoverage } from "@/lib/review-coverage";
import { getModelPricing } from "@/lib/cost";
import { resolveReviewModelPin } from "@/lib/ai-client";

/** Cheaper model for provably-mechanical diffs. Must exist in pricing (asserted in tests). */
export const MECHANICAL_MODEL = "claude-haiku-4-5-20251001";

/**
 * `OCTOPUS_MECHANICAL_MODEL` replaces MECHANICAL_MODEL. Setting it also lets an
 * org-level pin be downshifted, because a deployment that configures a mechanical
 * model has no other way to use it when its org pins the review model. Only a diff
 * made up entirely of mechanical files overrides a pin; the tiny-diff rule does not.
 */
function configuredMechanicalModel(): string | undefined {
  return process.env.OCTOPUS_MECHANICAL_MODEL?.trim() || undefined;
}

export type DiffTier = "mechanical" | "standard" | "complex";

export interface DiffClass {
  loc: number;
  files: number;
  tier: DiffTier;
  mechanicalOnly: boolean;
  /** `mechanicalOnly`, and no touched path is non-mechanical: rename sources and policy-excluded files included. */
  mechanicalEverywhere: boolean;
  highRisk: boolean;
}

// Files whose changes are mechanical/generated — safe to review on a cheap model.
const MECHANICAL_FILE = [
  /(?:^|\/)(?:package-lock\.json|bun\.lock|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock)$/,
  /\.min\.(?:js|css)$/,
  /\.(?:snap|lock)$/,
  /(?:^|\/)(?:dist|build|vendor|generated)\//,
  /\.(?:md|mdx|txt|rst)$/, // docs
];
// Tests-only diffs are lower-risk (still real code, but not shipped behaviour).
const TEST_FILE = [/(?:^|\/)__tests__\//, /\.(?:test|spec)\.[cm]?[jt]sx?$/, /(?:^|\/)tests?\//];
// High-risk shared surfaces — mirror of touchesSharedFiles in the review paths.
const HIGH_RISK_FILE = [
  /(?:types|interfaces|schema|models)\//,
  /(?:utils|helpers|shared|common)\//,
  /(?:config|\.env|docker|ci)\b/,
  /\.d\.ts$/,
  /(?:prisma\/schema|migrations\/)/,
  /(?:package\.json|tsconfig)/,
];

const anyMatch = (patterns: RegExp[], s: string) => patterns.some((p) => p.test(s));

const isMechanicalPath = (p: string) => anyMatch(MECHANICAL_FILE, p) || anyMatch(TEST_FILE, p);

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/gm;

/** Extract changed file paths from a unified diff (`diff --git a/… b/…`). */
export function extractChangedPaths(diff: string): string[] {
  const paths: string[] = [];
  for (const m of diff.matchAll(DIFF_HEADER)) {
    paths.push(m[2]); // the "b/" (new) path
  }
  return paths;
}

/** Every path a change touches: both sides of a rename or copy, and policy-excluded entries. */
function touchedPaths(diff: string, coverage?: ReviewCoverage): string[] {
  const paths = coverage
    ? coverage.files.flatMap((file) => [file.path, file.previousPath ?? file.path])
    : [...diff.matchAll(DIFF_HEADER)].flatMap((m) => [m[1], m[2]]);
  return [...new Set(paths)];
}

export function classifyDiff(diff: string, coverage?: ReviewCoverage): DiffClass {
  const paths = [...new Set(coverage ? coverage.files.filter(file => file.state !== "excluded").map(file => file.path) : extractChangedPaths(diff))];
  const files = paths.length;

  // Changed lines of code = added/removed content lines, excluding the +++/---
  // file headers.
  let loc = 0;
  for (const line of diff.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      loc++;
    }
  }

  const nonMechanical = paths.filter((p) => !isMechanicalPath(p));
  // Mechanical only if every changed file is a lockfile/generated/docs/test file
  // (and at least one file changed).
  const mechanicalOnly = files > 0 && nonMechanical.length === 0 && (!coverage || coverage.inventoryComplete);
  const mechanicalEverywhere = mechanicalOnly && touchedPaths(diff, coverage).every(isMechanicalPath);
  const highRisk = paths.some((p) => anyMatch(HIGH_RISK_FILE, p));

  let tier: DiffTier;
  if (mechanicalOnly) {
    // Lockfiles / generated / docs / tests are mechanical at any size.
    tier = "mechanical";
  } else if (highRisk || loc > 400 || files > 20) {
    tier = "complex";
  } else if (files <= 1 && loc <= 10 && (!coverage || coverage.complete)) {
    tier = "mechanical";
  } else {
    tier = "standard";
  }

  return { loc, files, tier, mechanicalOnly, mechanicalEverywhere, highRisk };
}

export interface ReviewRoute {
  model: string;
  /** The model the review would have used without the mechanical downshift; null when not downshifted. */
  downshiftedFrom: string | null;
}

/**
 * Resolve the review model for a diff. Precedence: explicit modelOverride → repo
 * pin → org pin → routed default. Only mechanical diffs are downshifted, and only
 * when the cheaper model actually has pricing. An org pin blocks the downshift
 * unless OCTOPUS_MECHANICAL_MODEL is set and every touched path is mechanical (both
 * sides of a rename, policy-excluded files included); a repo pin always blocks it.
 */
export async function resolveReviewRoute(args: {
  orgId: string;
  repoId?: string;
  modelOverride?: string;
  diff: string;
  coverage?: ReviewCoverage;
}): Promise<ReviewRoute> {
  const { orgId, repoId, modelOverride, diff } = args;

  // Explicit caller override always wins — never override a deliberate choice.
  if (modelOverride) return { model: modelOverride, downshiftedFrom: null };

  // Single lookup that also tells us where the model came from (single source
  // of truth for precedence lives in ai-client).
  const { model: base, source } = await resolveReviewModelPin(orgId, repoId);
  if (source === "repo") return { model: base, downshiftedFrom: null };
  const configured = configuredMechanicalModel();
  if (source === "org" && !configured) return { model: base, downshiftedFrom: null };

  const target = configured ?? MECHANICAL_MODEL;
  const cls = classifyDiff(diff, args.coverage);
  const qualifies = source === "org" ? cls.mechanicalEverywhere : cls.tier === "mechanical";
  if (qualifies && target !== base) {
    // Self-protect: never emit a model without pricing (would bill $0).
    const pricing = await getModelPricing().catch(() => null);
    if (pricing?.has(target)) return { model: target, downshiftedFrom: base };
    if (configured) console.warn(`[review-routing] OCTOPUS_MECHANICAL_MODEL ${configured} has no catalog row; not downshifting`);
  }
  return { model: base, downshiftedFrom: null };
}

export async function resolveReviewModel(args: Parameters<typeof resolveReviewRoute>[0]): Promise<string> {
  return (await resolveReviewRoute(args)).model;
}
