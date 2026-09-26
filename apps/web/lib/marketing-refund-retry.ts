import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@octopus/db";
import { serializeConversion, type MarketingConfig } from "./marketing-conversions";
import { deliveredMarketingPurchase } from "./marketing-outbox";
import { MarketingSourceError, marketingStripeReader, resolveStripeConversion, type MarketingStripeReader } from "./marketing-stripe";
import { getStripe } from "./stripe";

/** Only the pre-transport reference-compatibility failure is operator-recoverable. */
async function prepare(id: string, config: MarketingConfig, reader?: MarketingStripeReader) {
  const row = await prisma.marketingConversion.findUnique({ where: { id } });
  if (!row || row.sourceId !== config.sourceId || row.environment !== config.environment ||
      row.kind !== "refund" || !row.organizationId || !row.originKey.startsWith("ledger:") ||
      row.sourceCreatedAt < config.from || row.status !== "blocked" || row.errorCode !== "unsupported_refund_reference" ||
      row.payload !== null || row.receiptId !== null || row.httpStatus !== null || row.deliveredAt !== null ||
      row.leaseId !== null || row.leaseUntil !== null || row.attempts < 1) {
    throw new MarketingSourceError("refund_retry_ineligible");
  }
  if (await prisma.marketingConversion.count({ where: { sourceId: row.sourceId, kind: "refund", reference: row.reference } }) !== 1) {
    throw new MarketingSourceError("refund_retry_ambiguous");
  }
  const resolved = await resolveStripeConversion(reader ?? marketingStripeReader(getStripe()), "refund", row.reference, row.organizationId, config.environment);
  if (resolved.event.eventType !== "refund" || !resolved.originalPurchase) throw new MarketingSourceError("invalid_refund_source");
  const original = await deliveredMarketingPurchase(prisma, row, resolved.originalPurchase);
  if (!original) throw new MarketingSourceError("original_purchase_not_delivered");
  const preview = {
    outboxId: row.id, sourceId: row.sourceId, environment: row.environment, originKey: row.originKey,
    reference: row.reference, sourceCreatedAt: row.sourceCreatedAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    attempts: row.attempts, status: row.status, errorCode: row.errorCode,
    event: resolved.event,
    originalPurchase: { outboxId: original.id, receiptId: original.receiptId, updatedAt: original.updatedAt.toISOString() },
  };
  // Bind the preview to exact facts and runtime binding without exposing the key.
  const previewHash = createHash("sha256").update(JSON.stringify([preview, config.from.toISOString(), config.serverKey])).digest("hex");
  return { row, resolved, original, preview: { ...preview, previewHash } };
}

export async function previewMarketingRefundRetry(id: string, config: MarketingConfig, reader?: MarketingStripeReader) {
  return (await prepare(id, config, reader)).preview;
}

export async function retryMarketingRefund(id: string, previewHash: string, config: MarketingConfig, reader?: MarketingStripeReader) {
  const prepared = await prepare(id, config, reader);
  if (previewHash !== prepared.preview.previewHash) throw new MarketingSourceError("refund_retry_preview_changed");
  const { row, resolved, original } = prepared;
  await prisma.$transaction(async tx => {
    const current = await deliveredMarketingPurchase(tx, row, resolved.originalPurchase!);
    if (!current || current.id !== original.id || current.receiptId !== original.receiptId ||
        current.updatedAt.getTime() !== original.updatedAt.getTime()) throw new MarketingSourceError("original_payment_conflict");
    const updated = await tx.marketingConversion.updateMany({
      where: {
        id: row.id, sourceId: row.sourceId, environment: row.environment, kind: "refund", reference: row.reference,
        originKey: row.originKey, organizationId: row.organizationId, sourceCreatedAt: row.sourceCreatedAt,
        updatedAt: row.updatedAt, attempts: row.attempts, status: "blocked", errorCode: "unsupported_refund_reference",
        payload: null, receiptId: null, httpStatus: null, deliveredAt: null, leaseId: null, leaseUntil: null,
      },
      // Persist verified bytes once. The normal worker therefore cannot enqueue
      // another original purchase or reconstruct this refund after recovery.
      data: { status: "pending", nextAttemptAt: new Date(), payload: serializeConversion(resolved.event) },
    });
    if (updated.count !== 1) throw new MarketingSourceError("refund_retry_state_changed");
  }, { isolationLevel: "Serializable" });
  return { outboxId: row.id, eventId: resolved.event.eventId, status: "pending" as const };
}
