-- Additive per-member permission grants on top of the role baseline.
-- Expand-only: new column with a default, no backfill needed.
ALTER TABLE "organization_members" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT '{}';
