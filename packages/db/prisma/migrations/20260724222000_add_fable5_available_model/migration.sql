-- Add Claude Fable 5 (Claude 5 frontier model) as the top opt-in "max" review
-- tier at $10/$50 per 1M tokens. Data migration so the row lands in every
-- environment via `prisma migrate deploy`. isPlatformDefault stays false — the
-- default reviewer is unchanged. On conflict, refresh pricing/label/active but
-- never clobber an admin's isPlatformDefault or sortOrder choice.
-- sortOrder is -2 (free slot in already-populated DBs; sorts above Opus 5 at -1).
INSERT INTO "available_models"
  ("id","modelId","displayName","provider","category","inputPrice","outputPrice","isActive","isPlatformDefault","sortOrder","createdAt","updatedAt")
VALUES
  ('seed_claude_fable_5','claude-fable-5','Claude Fable 5','anthropic','llm',10,50,true,false,-2,now(),now())
ON CONFLICT ("modelId") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "provider"    = EXCLUDED."provider",
  "category"    = EXCLUDED."category",
  "inputPrice"  = EXCLUDED."inputPrice",
  "outputPrice" = EXCLUDED."outputPrice",
  "isActive"    = EXCLUDED."isActive",
  "updatedAt"   = now();
