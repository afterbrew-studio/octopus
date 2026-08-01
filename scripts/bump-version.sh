#!/usr/bin/env bash
# Bump the version in package.json and apps/web/package.json.
# Usage: scripts/bump-version.sh X.Y.Z
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 X.Y.Z" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in "$ROOT/package.json" "$ROOT/apps/web/package.json"; do
  node -e "const fs=require('fs');const p='$f';const j=JSON.parse(fs.readFileSync(p));j.version='$VERSION';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
  echo "Updated $f -> $VERSION"
done

# Stamp the CUSTOMER-FACING changelog: promote the accumulated `## [Unreleased]`
# notes into a dated `## [X.Y.Z]` section (Keep a Changelog convention) and open
# a fresh empty [Unreleased]. We only move human-written notes into place — never
# generate prose from commits. The release workflow (verify-changelog) refuses to
# ship a version that has no matching section, so this keeps /docs/changelog from
# ever falling behind.
VERSION="$VERSION" ROOT="$ROOT" node <<'NODE'
const fs = require("fs");
const v = process.env.VERSION;
const p = process.env.ROOT + "/CHANGELOG.md";
if (!fs.existsSync(p)) {
  console.warn("[bump-version] CHANGELOG.md not found — skipping changelog stamp");
  process.exit(0);
}
let c = fs.readFileSync(p, "utf8");
const esc = v.replace(/[.]/g, "\\.");
if (new RegExp("^## \\[" + esc + "\\]", "m").test(c)) {
  console.log(`[bump-version] CHANGELOG already has [${v}] — leaving as-is`);
  process.exit(0);
}
const capture = /## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[|\s*$)/;
const m = c.match(capture);
if (!m) {
  console.warn(`[bump-version] No [Unreleased] section — add a '## [${v}]' entry to CHANGELOG.md manually before releasing.`);
  process.exit(0);
}
let body = m[1].trim();
if (!body) {
  body = "- _Maintenance and internal improvements._";
  console.warn("[bump-version] WARNING: [Unreleased] had no notes — inserted a placeholder. Edit CHANGELOG.md with customer-facing notes before releasing.");
}
const date = new Date().toISOString().slice(0, 10);
const replacement = `## [Unreleased]\n\n## [${v}] - ${date}\n\n${body}\n`;
// Replacer FUNCTION, not a string: notes can contain `$` (e.g. "$5 / $25 per
// million tokens"), and String.replace would treat `$&`/`$1`/`$$` specially.
c = c.replace(capture, () => replacement);
fs.writeFileSync(p, c);
console.log(`[bump-version] Stamped CHANGELOG.md [${v}] - ${date}`);
NODE

echo "Now review CHANGELOG.md, commit, then tag: git tag v$VERSION"
