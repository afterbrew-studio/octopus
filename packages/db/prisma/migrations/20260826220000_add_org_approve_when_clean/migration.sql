-- Submit APPROVE on a review that found nothing, instead of COMMENT.
--
-- Defaults to false for every existing organization: approving is what lets an
-- automated merge proceed, so the authority is acquired deliberately rather
-- than granted by running a migration.
--
-- `organizations`, not `Organization`: the model carries `@@map("organizations")`,
-- so the Prisma model name is not the table name.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "approveWhenClean" BOOLEAN NOT NULL DEFAULT false;
