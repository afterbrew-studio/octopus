import "server-only";
import { prisma } from "@octopus/db";

/**
 * Renews this worker's claim on the row and reports whether it still holds it.
 *
 * A conditional write rather than a read. A read followed by a publication
 * leaves a window in which another worker can claim the row, and both then
 * publish. The write carries the claim token and the `reviewing` status, so it
 * only lands on a row this worker still owns and that nobody has reaped.
 * Landing also refreshes `updatedAt`, which every reclaim path (the claim query
 * and the reaper) requires to be older than the stale window, so the row cannot
 * be taken while the publication that follows is in flight.
 *
 * Idempotent: repeating it only moves `updatedAt` forward.
 */
export async function reserveClaim(pullRequestId: string, claimToken: string): Promise<boolean> {
  const { count } = await prisma.pullRequest.updateMany({
    where: { id: pullRequestId, claimToken, status: "reviewing" },
    data: { updatedAt: new Date() },
  });
  return count === 1;
}

/**
 * Whether this worker still holds the row, whatever its status. For the failure
 * path, which runs after a row may legitimately have left `reviewing`.
 *
 * A write for the same reason as `reserveClaim`, but conditioned on the claim
 * token alone: it must not be refused because the review already reached
 * `completed` or `failed` under this worker.
 */
export async function holdsClaim(pullRequestId: string, claimToken: string): Promise<boolean> {
  const { count } = await prisma.pullRequest.updateMany({
    where: { id: pullRequestId, claimToken },
    data: { updatedAt: new Date() },
  });
  return count === 1;
}

/** The claim was taken from this worker while it was publishing. */
export class ClaimLostError extends Error {
  constructor() {
    super("The review claim was taken by another worker");
    this.name = "ClaimLostError";
  }
}

/**
 * How often a publishing worker renews its claim. Far below the stale window
 * every reclaim path requires (the review timeout plus five minutes).
 */
export function claimRenewMs(): number {
  const configured = Number(process.env.OCTOPUS_CLAIM_RENEW_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000;
}

export type ClaimLease = {
  /** True once a renewal found the claim gone, or could not be confirmed. */
  readonly lost: boolean;
  /** Aborts when the lease is lost or after `callMs`, whichever comes first. */
  signal(callMs: number): AbortSignal;
  stop(): void;
};

const MAX_UNCONFIRMED_RENEWALS = 3;

/**
 * Reserves the claim and keeps it renewed until `stop()`, so a publication that
 * outlasts the stale window cannot be reclaimed while it is still running.
 *
 * One renewal is not enough: a provider call can run longer than the window. A
 * renewal that finds the claim gone, or that cannot be confirmed several times
 * in a row, marks the lease lost and aborts every signal handed out, so nothing
 * further is sent on a claim that may belong to someone else. Returns null when
 * the claim is not held to begin with.
 */
export async function acquireClaimLease(pullRequestId: string, claimToken: string): Promise<ClaimLease | null> {
  if (!(await reserveClaim(pullRequestId, claimToken))) return null;
  const controller = new AbortController();
  let lost = false;
  let stopped = false;
  let unconfirmed = 0;
  let renewal = Promise.resolve();
  const loseLease = () => {
    lost = true;
    controller.abort(new ClaimLostError());
  };
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (stopped || lost) return;
      let held: boolean;
      try {
        held = await reserveClaim(pullRequestId, claimToken);
      } catch {
        if (++unconfirmed >= MAX_UNCONFIRMED_RENEWALS && !stopped) loseLease();
        return;
      }
      unconfirmed = 0;
      if (!held && !stopped) loseLease();
    });
  }, claimRenewMs());
  timer.unref();
  return {
    get lost() { return lost; },
    signal: (callMs) => AbortSignal.any([controller.signal, AbortSignal.timeout(callMs)]),
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
