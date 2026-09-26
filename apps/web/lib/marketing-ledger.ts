import "server-only";
import { type Prisma } from "@octopus/db";

export type MarketingLedgerFact = { id: string; createdAt: Date; organizationId: string; type: string; stripeSessionId: string | null; stripeRefundId: string | null };

/** Same retained-ledger eligibility for inspection and normal capture. No provider calls. */
export async function readMarketingLedger(db: Pick<Prisma.TransactionClient, "$queryRaw">, from: Date, limit: number, missingSource: string | null = null) {
  return db.$queryRaw<MarketingLedgerFact[]>`
    SELECT c.id, c."createdAt", c."organizationId", c.type, c."stripeSessionId", c."stripeRefundId"
    FROM credit_transactions c
    WHERE c."createdAt" >= ${from}
      AND (c."stripeRefundId" IS NOT NULL OR (c.type IN ('purchase', 'auto_reload', 'subscription') AND c."stripeSessionId" IS NOT NULL))
      AND (${missingSource}::text IS NULL OR NOT EXISTS (SELECT 1 FROM marketing_conversions o
        WHERE o."sourceId" = ${missingSource} AND o."originKey" = 'ledger:' || c.id))
    ORDER BY c."createdAt", c.id LIMIT ${limit}`;
}
