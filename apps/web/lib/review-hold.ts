import "server-only";
import crypto from "node:crypto";
import { prisma, type Prisma } from "@octopus/db";
import { enqueue } from "@/lib/queue";

/**
 * A review is held when its commit has failing checks: reviewing a red build spends
 * a model call on a diff that is about to change. The run is not finished; it waits,
 * bound to the same request, and a recheck decides.
 */
export const HELD_STATE = "held";

export type HoldRecord = {
  /** Only the recheck job carrying this token may take the run. Anything older is stale. */
  token: string;
  /** Rechecks so far, which sets the backoff. */
  attempt: number;
  /** When the next recheck is due. */
  dueAt: string;
};

/** Minutes between rechecks: 2, 5, 10, then every 15. */
const BACKOFF_SECONDS = [120, 300, 600];
const STEADY_SECONDS = 900;

export function holdDelaySeconds(attempt: number): number {
  return BACKOFF_SECONDS[attempt] ?? STEADY_SECONDS;
}

/** Longest a review waits for its checks, from the request being admitted. Default 24h. */
export function holdMaxWaitMs(): number {
  const minutes = Number(process.env.OCTOPUS_HELD_REVIEW_MAX_WAIT_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 24 * 60) * 60_000;
}

/**
 * Whether the wait is over. Measured from the run's creation, so a lost job or a
 * restarted chain cannot stretch it; without a run (a job from before runs existed)
 * it is the time the backoff itself has already spent.
 */
export function holdExpired(runCreatedAt: Date | null, attempt: number, now: Date = new Date()): boolean {
  if (runCreatedAt) return now.getTime() - runCreatedAt.getTime() >= holdMaxWaitMs();
  let spent = 0;
  for (let i = 0; i < attempt; i++) spent += holdDelaySeconds(i) * 1000;
  return spent >= holdMaxWaitMs();
}

/** The hold for the recheck that follows hold number `attempt`; its record carries the next index. */
export function newHold(attempt: number, now: Date = new Date()): HoldRecord {
  return { token: crypto.randomUUID(), attempt: attempt + 1, dueAt: new Date(now.getTime() + holdDelaySeconds(attempt) * 1000).toISOString() };
}

function checkList(failing: string[]): string {
  const shown = failing.slice(0, 10).map((name) => `\`${name}\``).join(", ");
  return failing.length > 10 ? `${shown} and ${failing.length - 10} more` : shown;
}

/** The one status comment: edited in place on every state, never added to. */
export function heldNotice(headSha: string, failing: string[]): string {
  return `> 🐙 **Octopus Review** is waiting for checks to pass on commit \`${headSha.slice(0, 7)}\`.\n>\n`
    + `> Failing: ${checkList(failing)}.\n>\n`
    + "> The review runs automatically once they pass; nothing needs to be re-requested.";
}

export function heldGiveUpNotice(headSha: string, failing: string[], waitedMinutes: number): string {
  return `> 🐙 **Octopus Review** did not run: checks on commit \`${headSha.slice(0, 7)}\` were still failing after ${waitedMinutes} minutes (${checkList(failing)}).\n>\n`
    + "> Fix them and push, or comment `@octopus-review` to ask again.";
}

type HeldRun = { id: string; pullRequestId: string; hold: unknown };

/** Retires the pending recheck by writing a new token, then enqueues the one that holds it. */
async function issueRecheck(run: HeldRun, now: Date): Promise<boolean> {
  const current = run.hold as HoldRecord | null;
  const next: HoldRecord = { token: crypto.randomUUID(), attempt: current?.attempt ?? 0, dueAt: now.toISOString() };
  const taken = await prisma.reviewRun.updateMany({
    where: { id: run.id, state: HELD_STATE, terminalAt: null },
    data: { hold: next as unknown as Prisma.InputJsonValue },
  });
  if (!taken.count) return false;
  await enqueue("process-review", { pullRequestId: run.pullRequestId, reviewRunId: run.id, holdToken: next.token, holdAttempt: next.attempt });
  return true;
}

/**
 * A check finished: bring forward the recheck of any review held for this commit.
 *
 * The delayed recheck works on its own; this only shortens the wait when GitHub
 * tells us a check completed. A new token is written first, so the delayed job it
 * replaces becomes stale instead of racing the one enqueued here.
 */
export async function recheckHeldReviews(repositoryId: string, headSha: string): Promise<number> {
  const runs = await prisma.reviewRun.findMany({
    where: { state: HELD_STATE, terminalAt: null, headSha, pullRequest: { repositoryId } },
    select: { id: true, pullRequestId: true, hold: true },
  });
  let queued = 0;
  for (const run of runs) if (await issueRecheck(run, new Date())) queued++;
  return queued;
}

/**
 * A recheck job that was lost (the queue dropped it, or its retries ran out) leaves
 * a run held forever. One whose recheck is well overdue gets a fresh token and job.
 */
export async function requeueOverdueHolds(now: Date = new Date(), graceMs = 10 * 60_000): Promise<number> {
  const runs = await prisma.reviewRun.findMany({
    where: { state: HELD_STATE, terminalAt: null },
    select: { id: true, pullRequestId: true, hold: true },
  });
  let queued = 0;
  for (const run of runs) {
    const current = run.hold as HoldRecord | null;
    if (current && now.getTime() - Date.parse(current.dueAt) < graceMs) continue;
    if (await issueRecheck(run, now)) queued++;
  }
  return queued;
}
