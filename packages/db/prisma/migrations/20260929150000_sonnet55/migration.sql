-- Opt-in only; preserve existing defaults, pins and operator changes.
INSERT INTO "available_models"
 ("id","modelId","displayName","provider","category","inputPrice","outputPrice","isActive","isPlatformDefault","sortOrder","createdAt","updatedAt")
VALUES ('seed_claude_sonnet_5_5','claude-sonnet-5-5','Claude Sonnet 5.5','anthropic','llm',2,10,true,false,-4,now(),now())
ON CONFLICT ("modelId") DO NOTHING;
