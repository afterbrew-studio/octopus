-- Replace Claude Opus 4.6 with Claude Opus 4.8 in the offered catalogue.
-- Anthropic's current Opus tier is $5/$25 (down from the old $15/$75), so the
-- stale Opus 4.6 row is renamed in place to Opus 4.8 at the new price. Updating
-- the existing row preserves its sortOrder and any admin isPlatformDefault choice.
-- Idempotent: if no 4.6 row exists (fresh env already seeded with 4.8 via seed.ts)
-- this is a no-op.
UPDATE "available_models"
SET
  "modelId"     = 'claude-opus-4-8',
  "displayName" = 'Claude Opus 4.8',
  "inputPrice"  = 5,
  "outputPrice" = 25,
  "updatedAt"   = now()
WHERE "modelId" = 'claude-opus-4-6-20250619';
