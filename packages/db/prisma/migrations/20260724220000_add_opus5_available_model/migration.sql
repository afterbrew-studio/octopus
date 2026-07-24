-- Add Claude Opus 5 as an opt-in premium review model (#opus-5 launch).
-- Data migration so the row lands in every environment via `prisma migrate deploy`
-- (no manual seed / SSH). isPlatformDefault stays false — the default reviewer is
-- unchanged. On conflict, refresh pricing/label/active but never clobber an
-- admin's isPlatformDefault or sortOrder choice.
INSERT INTO "available_models"
  ("id","modelId","displayName","provider","category","inputPrice","outputPrice","isActive","isPlatformDefault","sortOrder","createdAt","updatedAt")
VALUES
  ('seed_claude_opus_5','claude-opus-5','Claude Opus 5','anthropic','llm',5,25,true,false,0,now(),now())
ON CONFLICT ("modelId") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "provider"    = EXCLUDED."provider",
  "category"    = EXCLUDED."category",
  "inputPrice"  = EXCLUDED."inputPrice",
  "outputPrice" = EXCLUDED."outputPrice",
  "isActive"    = EXCLUDED."isActive",
  "updatedAt"   = now();
