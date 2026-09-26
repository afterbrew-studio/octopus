-- migrate-check: allow-destructive
--
-- Frees the "review_attempts" name for upstream's independently-introduced
-- ReviewAttempt (immutable review-result evidence, added in
-- 20260910223000_review_coverage_attempts), which creates its own table of the
-- same name. This fork's existing config-freeze/state-machine table is
-- relocated to "review_runs" (Prisma model ReviewRun) rather than edited in
-- place, so the already-applied 20260825233000_add_review_attempts migration
-- is left untouched.
--
-- A RENAME is ordinarily backward-incompatible (a rolled-back old image would
-- reference a table that no longer exists under the old name), which is what
-- migrate-check.yml guards against. It does not apply to this deployment:
-- production is a single `octopus-web` container with no rolling window --
-- the operator stops it, drains the queue, runs migrations, then starts the
-- new image, so no old-version code is ever running against the renamed
-- table. Every existing row is preserved: RENAME moves the table, it does not
-- recreate it.
ALTER TABLE "review_attempts" RENAME TO "review_runs";
ALTER TABLE "review_runs" RENAME CONSTRAINT "review_attempts_pkey" TO "review_runs_pkey";
ALTER TABLE "review_runs" RENAME CONSTRAINT "review_attempts_pullRequestId_fkey" TO "review_runs_pullRequestId_fkey";
ALTER INDEX "review_attempts_pullRequestId_createdAt_idx" RENAME TO "review_runs_pullRequestId_createdAt_idx";
ALTER INDEX "review_attempts_state_idx" RENAME TO "review_runs_state_idx";
