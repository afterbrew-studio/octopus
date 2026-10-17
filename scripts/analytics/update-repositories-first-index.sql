\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '15s';

DO $$
BEGIN
  IF to_regnamespace('octopus_analytics') IS NULL THEN
    RAISE EXCEPTION 'Analytics schema missing; install access.sql before this update';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'octopus_analytics' AND c.relname = 'repositories_v1'
      AND c.relkind = 'v'
  ) THEN
    RAISE EXCEPTION 'Analytics repositories_v1 view missing; install access.sql before this update';
  END IF;
END $$;

CREATE OR REPLACE VIEW octopus_analytics.repositories_v1 WITH (security_barrier = true) AS
SELECT 'octopus:repo:' || id AS repository_id,
  'octopus:org:' || "organizationId" AS organization_id,
  CASE WHEN provider IN ('github','gitlab','bitbucket','forgejo') THEN provider ELSE 'other' END AS provider,
  "createdAt" AS connected_at, "isActive" AS is_active, "autoReview" AS auto_review,
  CASE WHEN "indexStatus" IN ('pending','indexing','indexed','failed') THEN "indexStatus" ELSE 'unknown' END AS index_status,
  "indexedAt" AS latest_index_at,
  "firstIndexedAt" AS first_index_at
FROM public.repositories;

COMMIT;
