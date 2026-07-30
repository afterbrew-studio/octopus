import ignore, { type Ignore } from "ignore";

/**
 * Generated files nobody hand-writes. Reviewing them wastes the diff budget and,
 * because they often sort early (e.g. ORM snapshots, lockfiles), crowds real
 * hand-written files out of the review entirely (#1429). We exclude them from
 * the reviewed diff — detected via a curated default list PLUS the repo's own
 * `.gitattributes` `linguist-generated` / `-diff` markers.
 *
 * Kept conservative to avoid hiding real code: only clear-cut generated paths.
 * Repos extend this with `.gitattributes` for anything project-specific.
 */
export const DEFAULT_GENERATED_PATTERNS: string[] = [
  // Dependency lockfiles
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "flake.lock",
  // ORM migration snapshots (the #1429 case — Drizzle emits a large JSON snapshot)
  "**/drizzle/meta/**",
  "**/atlas.sum",
  // Test snapshots
  "**/*.snap",
  "**/__snapshots__/**",
  // Minified / source maps / bundled output
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  // Common codegen outputs
  "**/*.pb.go",
  "**/*_pb2.py",
  "**/*_pb2.pyi",
  "**/*.pb.cc",
  "**/*.pb.h",
];

/**
 * Extract path patterns marked as generated in a `.gitattributes` file:
 * `linguist-generated` (bare or `=true`) or `-diff`. `=false` un-marks and is
 * skipped. Returns gitignore-compatible globs (gitattributes globs are close
 * enough for the `ignore` matcher; a leading `/`-less pattern matches anywhere).
 */
export function parseGitattributesGenerated(content: string): string[] {
  const patterns: string[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    if (!pattern) continue;
    const unsets = attrs.some((a) => a === "linguist-generated=false" || a === "linguist-generated=");
    const marksGenerated = attrs.some(
      (a) => a === "linguist-generated" || a === "linguist-generated=true" || a === "-diff",
    );
    // `=false` un-marks a file (e.g. re-include one file matched by a broader
    // rule or a default). Emit an `ignore` negation so it's kept in review.
    // Order is preserved so a later negation overrides an earlier match.
    if (unsets) patterns.push(`!${pattern}`);
    else if (marksGenerated) patterns.push(pattern);
  }
  return patterns;
}

/**
 * Build an `ignore` matcher for generated files: the built-in defaults plus any
 * `.gitattributes` generated markers. Pass the repo's `.gitattributes` content
 * (or omit for defaults-only).
 */
export function buildGeneratedMatcher(gitattributesContent?: string | null): Ignore {
  const ig = ignore();
  ig.add(DEFAULT_GENERATED_PATTERNS);
  if (gitattributesContent) ig.add(parseGitattributesGenerated(gitattributesContent));
  return ig;
}

/**
 * Split a unified diff into the files to review vs. the files an `ignore` matcher
 * excludes (generated and/or `.octopusignore`). Returns the kept diff and the
 * list of excluded file paths (for a review-summary note).
 */
export function splitDiffByIgnore(diff: string, ig: Ignore): { kept: string; skipped: string[] } {
  const sections = diff.split(/(?=^diff --git )/m);
  const skipped: string[] = [];
  const keptSections = sections.filter((section) => {
    const match = section.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!match) return true; // preamble / unparseable — keep
    const path = match[2];
    if (ig.ignores(path)) {
      skipped.push(path);
      return false;
    }
    return true;
  });
  return { kept: keptSections.join(""), skipped };
}
