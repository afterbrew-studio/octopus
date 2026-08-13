-- Retire Opus 4.6 / 4.7 and give the LLM catalog a clean, newest-first order.
-- Prod had drifted from the seed: it still carried claude-opus-4-6 and
-- claude-opus-4-7 (dropped from the seed but never removed) and most rows had
-- sortOrder = 0, so the model dropdown looked jumbled.

-- 1. Reassign every org/repo still pointed at the retired models to Opus 4.8
--    (proven-live). MUST run before the DELETE so nothing references a removed
--    model. No-ops on installs that never had them.
UPDATE "organizations" SET "defaultModelId" = 'claude-opus-4-8'
  WHERE "defaultModelId" IN ('claude-opus-4-6', 'claude-opus-4-7');
UPDATE "repositories" SET "reviewModelId" = 'claude-opus-4-8'
  WHERE "reviewModelId" IN ('claude-opus-4-6', 'claude-opus-4-7');

-- 2. Remove the retired catalog rows.
DELETE FROM "available_models"
  WHERE "modelId" IN ('claude-opus-4-6', 'claude-opus-4-7');

-- 3. Newest-first, grouped by provider (Anthropic, then Google, OpenAI, local).
--    UPDATEs are keyed on modelId, so models an install doesn't have are no-ops.
UPDATE "available_models" SET "sortOrder" = 0  WHERE "modelId" = 'claude-opus-5';
UPDATE "available_models" SET "sortOrder" = 1  WHERE "modelId" = 'claude-opus-4-8';
UPDATE "available_models" SET "sortOrder" = 2  WHERE "modelId" IN ('claude-sonnet-4-6', 'claude-sonnet-4-6-20250619');
UPDATE "available_models" SET "sortOrder" = 3  WHERE "modelId" = 'claude-haiku-4-5-20251001';
UPDATE "available_models" SET "sortOrder" = 4  WHERE "modelId" = 'claude-fable-5';
UPDATE "available_models" SET "sortOrder" = 5  WHERE "modelId" = 'claude-sonnet-4-20250514';
UPDATE "available_models" SET "sortOrder" = 6  WHERE "modelId" = 'claude-opus-4-20250514';
UPDATE "available_models" SET "sortOrder" = 10 WHERE "modelId" = 'gemini-2.5-pro';
UPDATE "available_models" SET "sortOrder" = 11 WHERE "modelId" = 'gemini-2.5-flash';
UPDATE "available_models" SET "sortOrder" = 12 WHERE "modelId" = 'gpt-5.3-codex';
UPDATE "available_models" SET "sortOrder" = 20 WHERE "modelId" = 'claude-code:sonnet';
UPDATE "available_models" SET "sortOrder" = 30 WHERE "modelId" = 'ollama:qwen2.5-coder:14b';
UPDATE "available_models" SET "sortOrder" = 31 WHERE "modelId" = 'ollama:qwen2.5-coder:7b';
