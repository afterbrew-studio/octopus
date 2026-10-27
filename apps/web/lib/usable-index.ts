/**
 * Whether a repository can be reviewed against its stored index regardless of
 * indexStatus. Completion writes indexedAt and totalVectors together with the
 * active generation, and a failed or replaced attempt never clears them, so
 * they outlive a stale, failed or in-flight refresh. Legacy snapshots (no
 * active generation) qualify too.
 */

export const USABLE_INDEX_WHERE = { indexedAt: { not: null }, totalVectors: { gt: 0 } };

export function hasUsableIndex(repo: { indexedAt: Date | null; totalVectors: number }): boolean {
  return repo.indexedAt !== null && repo.totalVectors > 0;
}

export type IndexGate = {
  /** No usable index: the review must wait for a full index. */
  blockOnIndex: boolean;
  /** A usable index is out of date and nothing is refreshing it. */
  refresh: boolean;
};

export function resolveIndexGate(repo: { indexStatus: string; indexedAt: Date | null; totalVectors: number }): IndexGate {
  if (repo.indexStatus === "indexed") return { blockOnIndex: false, refresh: false };
  if (!hasUsableIndex(repo)) return { blockOnIndex: true, refresh: false };
  return { blockOnIndex: false, refresh: repo.indexStatus !== "indexing" };
}
