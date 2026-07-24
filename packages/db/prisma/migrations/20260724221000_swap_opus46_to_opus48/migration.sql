-- Replace Claude Opus 4.6 with Claude Opus 4.8 in the offered catalogue.
-- Anthropic's current Opus tier is $5/$25 (down from the old $15/$75). Some
-- environments already have a claude-opus-4-8 row, so we do NOT rename 4.6 in
-- place (that collides on the unique modelId). Instead: ensure 4.8 exists at
-- the right price (insert or refresh), then drop the stale 4.6 row.
-- Fully idempotent regardless of which rows already exist.
INSERT INTO "available_models"
  ("id","modelId","displayName","provider","category","inputPrice","outputPrice","isActive","isPlatformDefault","sortOrder","createdAt","updatedAt")
VALUES
  ('seed_claude_opus_4_8','claude-opus-4-8','Claude Opus 4.8','anthropic','llm',5,25,true,false,1,now(),now())
ON CONFLICT ("modelId") DO UPDATE SET
  "displayName" = EXCLUDED."displayName",
  "inputPrice"  = EXCLUDED."inputPrice",
  "outputPrice" = EXCLUDED."outputPrice",
  "isActive"    = EXCLUDED."isActive",
  "updatedAt"   = now();

DELETE FROM "available_models" WHERE "modelId" = 'claude-opus-4-6-20250619';
