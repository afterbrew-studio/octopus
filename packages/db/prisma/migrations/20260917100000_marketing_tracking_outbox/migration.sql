-- Add tracking records to the existing durable outbox. Existing event bytes,
-- source identities, lease fences and delivery behavior stay unchanged.
ALTER TABLE marketing_conversions DROP CONSTRAINT marketing_conversions_kind_check;
ALTER TABLE marketing_conversions ADD CONSTRAINT marketing_conversions_kind_check
  CHECK (kind IN ('registration', 'purchase', 'refund', 'visit', 'conversion_context'));
ALTER TABLE marketing_conversions ADD CONSTRAINT marketing_tracking_payload_check
  CHECK (kind NOT IN ('visit', 'conversion_context') OR
    (payload IS NOT NULL AND octet_length(payload) <= 4096 AND "organizationId" IS NULL));
