CREATE TABLE "marketing_conversions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "environment" TEXT NOT NULL CHECK ("environment" IN ('test', 'live')),
  "originKey" TEXT NOT NULL,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('registration', 'purchase', 'refund')),
  "reference" TEXT NOT NULL,
  "organizationId" TEXT,
  "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
  "payload" TEXT CHECK (octet_length("payload") <= 16384),
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending', 'processing', 'delivered', 'blocked')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseId" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "receiptId" TEXT,
  "httpStatus" INTEGER,
  "errorCode" TEXT,
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK (("status" = 'processing' AND "leaseId" IS NOT NULL AND "leaseUntil" IS NOT NULL)
    OR ("status" <> 'processing' AND "leaseId" IS NULL AND "leaseUntil" IS NULL)),
  CHECK ("status" <> 'delivered' OR ("payload" IS NOT NULL AND "receiptId" IS NOT NULL AND "deliveredAt" IS NOT NULL))
);
CREATE UNIQUE INDEX "marketing_conversions_sourceId_originKey_key" ON "marketing_conversions" ("sourceId", "originKey");
CREATE INDEX "marketing_conversions_sourceId_status_nextAttemptAt_idx" ON "marketing_conversions" ("sourceId", "status", "nextAttemptAt");
CREATE INDEX "users_createdAt_id_idx" ON "users" ("createdAt", "id");
-- Exclude the much larger ordinary credit-usage stream from reconciliation.
CREATE INDEX "credit_transactions_marketing_facts_idx" ON "credit_transactions" ("createdAt", "id")
WHERE "stripeRefundId" IS NOT NULL
   OR ("type" IN ('purchase', 'auto_reload', 'subscription') AND "stripeSessionId" IS NOT NULL);

-- Persisted request bytes and source identity survive retries and key rotation.
-- A stale worker or later refactor must not rewrite an already attempted event.
CREATE FUNCTION preserve_marketing_conversion_identity() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."sourceId", NEW."environment", NEW."originKey", NEW."kind", NEW."reference", NEW."organizationId", NEW."sourceCreatedAt")
     IS DISTINCT FROM ROW(OLD."sourceId", OLD."environment", OLD."originKey", OLD."kind", OLD."reference", OLD."organizationId", OLD."sourceCreatedAt")
     OR (OLD."payload" IS NOT NULL AND NEW."payload" IS DISTINCT FROM OLD."payload") THEN
    RAISE EXCEPTION 'Marketing conversion identity and persisted payload are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER marketing_conversion_identity_immutable
BEFORE UPDATE ON "marketing_conversions"
FOR EACH ROW EXECUTE FUNCTION preserve_marketing_conversion_identity();
