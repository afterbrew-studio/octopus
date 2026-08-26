-- Submit APPROVE on a review that found nothing, instead of COMMENT.
--
-- Defaults to false for every existing organization: approving is what lets an
-- automated merge proceed, so the authority is acquired deliberately rather
-- than granted by running a migration.
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "approveWhenClean" BOOLEAN NOT NULL DEFAULT false;
