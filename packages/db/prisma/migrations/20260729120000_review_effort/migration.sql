-- Thinking-model effort settings (expand-only, both nullable — safe on live).
-- Per-org override; null = inherit the platform default.
ALTER TABLE "organizations" ADD COLUMN "reviewEffort" TEXT;
-- Platform default; null = the built-in code default (medium).
ALTER TABLE "system_config" ADD COLUMN "defaultReviewEffort" TEXT;
