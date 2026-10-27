/**
 * Timing contract between a running index attempt and everything that judges
 * it dead. The attempt touches Repository.updatedAt while it makes progress;
 * silence, not total duration, is the crash signal.
 */

export const INDEX_HEARTBEAT_INTERVAL_MS = 60_000;

/** Silence after which an `indexing` row belongs to a crashed worker. Must exceed the longest gap between progress points (one embedding batch). */
export const INDEX_SILENCE_LIMIT_MS = 15 * 60_000;

/** pg-boss expiry of one background index run; a first full embed on CPU takes hours. */
export const INDEX_JOB_EXPIRE_SECONDS = 4 * 60 * 60;

/** The in-process abort fires first so the failure path can release the claim before pg-boss expires the attempt. */
export const INDEX_JOB_ABORT_MS = (INDEX_JOB_EXPIRE_SECONDS - 120) * 1000;

/** Wraps `touch` so it runs at most once per heartbeat interval; the first call waits a full interval because the claim just touched the row. */
export function throttledHeartbeat(
  touch: () => Promise<void>,
  now: () => number = Date.now,
): () => Promise<void> {
  let last = now();
  return async () => {
    if (now() - last < INDEX_HEARTBEAT_INTERVAL_MS) return;
    last = now();
    await touch();
  };
}
