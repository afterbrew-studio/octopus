import "server-only";
import { prisma, type Prisma } from "@octopus/db";
import { enqueueAfter } from "@/lib/queue";
import { AmbiguousPublicationError } from "@/lib/review-publication";

export type VerdictEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";

/**
 * A review verdict that may be standing on the pull request without the worker
 * knowing it. An APPROVE or REQUEST_CHANGES stays in force on the commit it names
 * until it is dismissed, so one whose outcome was not observed (a lost answer, a
 * lost claim, a crash) has to be found and, if it belongs to a request that has
 * since been replaced, withdrawn.
 */
export type PublicationRecord = {
  /** pending: not yet settled. current: active for the live request. dismissed. absent: never appeared. */
  state: "pending" | "current" | "dismissed" | "absent";
  runId: string | null;
  pullRequestId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string | null;
  reviewRequestVersion: number;
  /** The commit the review names. */
  commitId: string | null;
  event: "REQUEST_CHANGES" | "APPROVE";
  sentAt: string;
  /** Reconcile passes that found nothing. */
  checks: number;
};

export const RECONCILE_QUEUE = "reconcile-review-publication";
/** Past the longest provider call, so a request still in flight has landed or failed. */
export const RECONCILE_DELAY_SECONDS = 120;

export type VerdictResult =
  | { kind: "published"; reviewId: number }
  /** Sent, outcome unknown. Never repeated here; the reconcile decides. */
  | { kind: "unresolved" }
  | { kind: "not-reserved" }
  | { kind: "rejected"; error: unknown };

/** Persisted before the provider call: the record on the run, and the job that settles it. */
export async function recordPublication(record: PublicationRecord): Promise<void> {
  if (record.runId) {
    await prisma.reviewRun.updateMany({ where: { id: record.runId }, data: { publication: record as unknown as Prisma.InputJsonValue } });
  }
  const jobId = await enqueueAfter(RECONCILE_QUEUE, record, RECONCILE_DELAY_SECONDS);
  if (!jobId) throw new Error("Could not schedule publication reconciliation");
}

/**
 * One provider write that carries a verdict.
 *
 * Reserved first, so a worker that cannot prove its claim sends nothing. A verdict
 * with standing is recorded durably before it is sent, and if that fails nothing is
 * sent. An unknown outcome is returned, never repeated: a second send could
 * duplicate a review that was applied.
 */
export async function submitVerdict(options: {
  event: VerdictEvent;
  reserve: () => Promise<boolean>;
  record: Omit<PublicationRecord, "state" | "event" | "sentAt" | "checks">;
  send: () => Promise<number>;
}): Promise<VerdictResult> {
  if (!(await options.reserve())) return { kind: "not-reserved" };
  if (options.event !== "COMMENT") {
    await recordPublication({ ...options.record, event: options.event, state: "pending", sentAt: new Date().toISOString(), checks: 0 });
  }
  try {
    return { kind: "published", reviewId: await options.send() };
  } catch (error) {
    if (error instanceof AmbiguousPublicationError) return { kind: "unresolved" };
    return { kind: "rejected", error };
  }
}
