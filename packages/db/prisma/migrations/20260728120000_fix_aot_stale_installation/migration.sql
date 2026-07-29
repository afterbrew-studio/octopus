-- One-time production data repair (guarded, no-op everywhere else).
--
-- The 'aot' (Art-of-Technology) organization row held a STALE GitHub App
-- installation id (111815536) left over from a previous install. The LIVE
-- installation is 111609667 — confirmed via the GitHub API (all-repos, not
-- suspended) and matched by every `repositories.installationId` row for that
-- org. Because the package analyzer resolves GitHub access from the ORG's
-- installation id, the stale value made private-repo analyses fail with
-- "Repository not found or not accessible" (and any other current-org feature
-- that reads the org installation was affected).
--
-- Guarded on BOTH the slug and the exact stale value, so this matches only the
-- one affected prod row and is a no-op in every other environment (self-host,
-- dev, CI) where no such row exists.
--
-- githubInstallationId is UNIQUE, so also guard on no other row already holding
-- the target id: otherwise the UPDATE would raise a unique violation and abort
-- the entire `migrate deploy`. No org currently holds 111609667, so this
-- applies now; the guard just turns a future collision into a safe no-op.
UPDATE "organizations"
SET "githubInstallationId" = 111609667,
    "updatedAt" = now()
WHERE "slug" = 'aot'
  AND "githubInstallationId" = 111815536
  AND NOT EXISTS (
    SELECT 1 FROM "organizations" WHERE "githubInstallationId" = 111609667
  );
