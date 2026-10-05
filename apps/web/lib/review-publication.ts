/**
 * Longest a single provider call in the publication phase may run. Below the
 * stale window the claim lease protects, so one hung call ends before the lease
 * could matter, and a hang cannot keep the heartbeat alive indefinitely.
 */
export function publicationCallTimeoutMs(): number {
  const configured = Number(process.env.OCTOPUS_PUBLICATION_CALL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

/**
 * Identifies the review one execution published, so a request whose outcome is
 * unknown can be reconciled by looking for it. At the front of the body because
 * providers truncate from the end.
 */
export function attemptMarker(attemptId: string): string {
  return `<!-- octopus-attempt:${attemptId} -->`;
}

/** A write whose outcome could not be established, so it must not be repeated blindly. */
export class PublicationOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(`Could not establish whether the review was published: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PublicationOutcomeUnknownError";
  }
}

/**
 * A write whose outcome is unknown: the request may or may not have been applied.
 * Distinct from a rejection, which is definitive. The caller reconciles before it
 * repeats the write.
 */
export class AmbiguousPublicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousPublicationError";
  }
}

/**
 * Sends one write whose outcome can be unknown, without ever sending it twice.
 *
 * When `send` fails with an unknown outcome, `find` looks for the write by its
 * identity before anything is repeated: found means it was applied. A write that
 * is provably absent is sent once more; a failed lookup is not an absence, so it
 * ends here as `PublicationOutcomeUnknownError`. A rejection is definitive and is
 * rethrown for the caller's own fallback.
 */
export async function publishOnce(options: {
  send: () => Promise<number>;
  find: () => Promise<number | null>;
  /** Throws when the right to publish was lost; checked before anything is repeated. */
  assertHeld?: () => void;
  retryDelayMs?: number;
}): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await options.send();
    } catch (error) {
      options.assertHeld?.();
      if (!(error instanceof AmbiguousPublicationError)) throw error;
      let published: number | null;
      try {
        published = await options.find();
      } catch (lookup) {
        throw new PublicationOutcomeUnknownError(lookup);
      }
      if (published !== null) return published;
      if (attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1000));
      options.assertHeld?.();
    }
  }
}
