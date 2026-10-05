/**
 * A deferral parked the pull request at `pending` but could not schedule the
 * retry. The run must stay alive: the job is retried by the queue, and the
 * pending-row reconciler only recovers a pending row whose run is not terminal.
 */
export class DeferralEnqueueError extends Error {
  constructor(cause?: unknown) {
    super(`Could not schedule the deferred review${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "DeferralEnqueueError";
  }
}
