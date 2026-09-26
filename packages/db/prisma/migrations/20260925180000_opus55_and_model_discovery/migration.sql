ALTER TABLE "system_config" ADD COLUMN "modelDiscovery" JSONB;
-- Opt-in only; preserve existing defaults, pins and operator changes.
INSERT INTO "available_models"
 ("id","modelId","displayName","provider","category","inputPrice","outputPrice","isActive","isPlatformDefault","sortOrder","createdAt","updatedAt")
VALUES ('seed_claude_opus_5_5','claude-opus-5-5','Claude Opus 5.5','anthropic','llm',4,20,true,false,-3,now(),now())
ON CONFLICT ("modelId") DO NOTHING;
