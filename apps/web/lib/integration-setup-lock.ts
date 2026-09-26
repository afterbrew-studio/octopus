import "server-only";
import { prisma, type Prisma } from "@octopus/db";

export async function acquireWebhookSetupLock(tx: Prisma.TransactionClient, key: string) {
  const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`webhook-setup:${key}`}, 0)) AS acquired`;
  if (!lock?.acquired) throw new Error("Webhook setup or connection change is already running. Retry shortly.");
}

export async function withWebhookSetupLock<T>(keys: string | string[], setup: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    for (const key of typeof keys === "string" ? [keys] : keys) await acquireWebhookSetupLock(tx, key);
    return setup(tx);
  }, { timeout: 60_000 });
}
