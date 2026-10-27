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

/** pg-boss expiry of a community review job; a token-backed refresh after its review must end inside it. */
export const COMMUNITY_REVIEW_EXPIRE_SECONDS = 30 * 60;

/** Queue of merged-PR index updates: singleton policy, so one active job per repository (the job's singleton key). */
export const INCREMENTAL_INDEX_QUEUE = "incremental-index";
export const INCREMENTAL_INDEX_EXPIRE_SECONDS = 30 * 60;
/** A failed update marks the index stale itself, so a failed job is not retried. */
export const INCREMENTAL_INDEX_QUEUE_OPTIONS = {
  policy: "singleton", retryLimit: 0, expireInSeconds: INCREMENTAL_INDEX_EXPIRE_SECONDS,
} as const;

/** The in-process abort fires this long before expiry so the failure path can release the claim first. */
export const INDEX_JOB_ABORT_MARGIN_SECONDS = 120;

/** Follows the job's own expiry, which can differ from the current default for jobs queued earlier. */
export function indexJobAbortMs(expireInSeconds: number = INDEX_JOB_EXPIRE_SECONDS): number {
  return Math.max(1, expireInSeconds - INDEX_JOB_ABORT_MARGIN_SECONDS) * 1000;
}

/** A replacement attempt or cancellation owns the row now. */
export class SupersededIndexError extends Error {
  constructor() { super("Indexing attempt is no longer current"); }
}

/** Longest a single outbound request may stay silent; well inside INDEX_SILENCE_LIMIT_MS. */
export const INDEX_REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Per Qdrant request on the indexing paths; four attempts plus backoff stay under half the silence limit. */
export const INDEX_QDRANT_REQUEST_TIMEOUT_MS = 90_000;

/** Longest rate-limit wait honored before the attempt gives up on a file. */
export const INDEX_MAX_RATE_LIMIT_WAIT_MS = 10 * 60_000;

export function requestSignal(signal?: AbortSignal, timeoutMs: number = INDEX_REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Sleeps in heartbeat-sized slices so a long wait keeps the attempt alive. */
export async function waitWhileAlive(ms: number, beat: () => Promise<void>, signal?: AbortSignal): Promise<void> {
  for (let left = Math.min(ms, INDEX_MAX_RATE_LIMIT_WAIT_MS); left > 0; left -= INDEX_HEARTBEAT_INTERVAL_MS) {
    signal?.throwIfAborted();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(left, INDEX_HEARTBEAT_INTERVAL_MS));
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    signal?.throwIfAborted();
    await beat();
  }
}

/** At most one `touch` per heartbeat interval; the first waits a full interval since the claim just touched the row. */
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
