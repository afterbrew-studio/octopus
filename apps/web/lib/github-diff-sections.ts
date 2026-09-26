/** Index unambiguous Git sections once, rejecting duplicate old/new aliases. */
export function indexGitHubDiffSections(rawDiff: string): Map<string, string> {
  const sections = new Map<string, string>();
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const section of rawDiff.split(/(?=^diff --git )/m)) {
    if (!section) continue;
    const paths = /^diff --git a\/(.+?) b\/(.+)\n/.exec(section);
    // Quoted or uninterpretable headers may alias a candidate path.
    if (!paths) return new Map();
    for (const path of new Set([paths[1], paths[2]])) {
      if (seen.has(path)) { conflicts.add(path); sections.delete(path); }
      seen.add(path);
    }
    if (!conflicts.has(paths[1]) && !conflicts.has(paths[2])) sections.set(paths[2], section);
  }
  return sections;
}
