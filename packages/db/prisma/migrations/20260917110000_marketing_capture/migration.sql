ALTER TABLE "users" ADD COLUMN "marketingVisitId" TEXT;
CREATE TABLE "marketing_payment_attributions" (
  "id" TEXT PRIMARY KEY,
  "sourceId" TEXT NOT NULL,
  "environment" TEXT NOT NULL CHECK ("environment" IN ('test', 'live')),
  "trackingId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "visitorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paymentReference" TEXT,
  "completedAt" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("visitorId" IS NULL OR "visitorId" ~ '^visitor_[a-f0-9]{64}$'),
  CHECK ("paymentReference" IS NULL OR "paymentReference" ~ '^(pi|cs)_[A-Za-z0-9_]+$')
);
CREATE UNIQUE INDEX "marketing_payment_attributions_sourceId_paymentReference_key"
  ON "marketing_payment_attributions" ("sourceId", "paymentReference");
CREATE INDEX "marketing_payment_attributions_pending_idx"
  ON "marketing_payment_attributions" ("sourceId", "trackingId", "completedAt", "nextAttemptAt");
CREATE FUNCTION marketing_attribution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD."id", OLD."sourceId", OLD."environment", OLD."trackingId", OLD."organizationId", OLD."visitorId", OLD."createdAt")
    IS DISTINCT FROM ROW(NEW."id", NEW."sourceId", NEW."environment", NEW."trackingId", NEW."organizationId", NEW."visitorId", NEW."createdAt")
    OR (OLD."paymentReference" IS NOT NULL AND OLD."paymentReference" IS DISTINCT FROM NEW."paymentReference") THEN
    RAISE EXCEPTION 'marketing attribution identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketing_attribution_immutable BEFORE UPDATE ON "marketing_payment_attributions"
  FOR EACH ROW EXECUTE FUNCTION marketing_attribution_immutable();
CREATE FUNCTION marketing_signup_visit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."marketingVisitId" IS DISTINCT FROM NEW."marketingVisitId" THEN
    RAISE EXCEPTION 'signup attribution is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER marketing_signup_visit_immutable BEFORE UPDATE OF "marketingVisitId" ON "users"
  FOR EACH ROW EXECUTE FUNCTION marketing_signup_visit_immutable();
