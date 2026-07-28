-- Make Claude Opus 4.8 the platform default review model (was Sonnet 4.6).
-- Resolution order for a repo's reviewer is repo-pin → org-pin → THIS platform
-- default → hardcoded fallback, so this changes the model an un-pinned org
-- (e.g. a brand-new signup) gets. Opus 4.8 is a Claude-4.x model (thinking is
-- opt-in, like Sonnet 4.6), so it does NOT need the always-thinking treatment
-- and won't starve as the default.
--
-- Scoped to the VENDOR production DB via `EXISTS (… slug='aot')` — the same
-- guard the org-binding repair used — so self-host / dev / CI keep their own
-- default (this is a hosted-product config choice, not a schema change). Also
-- guarded on Opus 4.8 being present + active. Idempotent.

-- 1. Clear the current llm default (only in the vendor env, only if Opus 4.8 exists).
UPDATE "available_models"
SET "isPlatformDefault" = false, "updatedAt" = now()
WHERE category = 'llm'
  AND "isPlatformDefault"
  AND EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'aot')
  AND EXISTS (
    SELECT 1 FROM "available_models"
    WHERE "modelId" = 'claude-opus-4-8' AND category = 'llm' AND "isActive"
  );

-- 2. Set Opus 4.8 as the default (vendor env only).
UPDATE "available_models"
SET "isPlatformDefault" = true, "updatedAt" = now()
WHERE category = 'llm'
  AND "modelId" = 'claude-opus-4-8'
  AND "isActive"
  AND EXISTS (SELECT 1 FROM "organizations" WHERE "slug" = 'aot');
