-- The "Latest" label now lives in the model picker UI (LATEST_MODEL_ID in
-- apps/web/lib/model-latest.ts), shown dynamically on the current latest model.
-- It should NOT be baked into model display names, where it goes stale. Strip a
-- trailing " Latest" from any available_models display name. Idempotent: a
-- second run matches nothing.
UPDATE "available_models"
SET "displayName" = regexp_replace("displayName", '\s*Latest$', ''),
    "updatedAt" = now()
WHERE "displayName" LIKE '% Latest';
