-- Global index on device fingerprint so we can count distinct users sharing
-- one fingerprint (the multi-account / Sybil signal). Expand-only.
--
-- Plain (non-CONCURRENT) CREATE INDEX takes a brief ACCESS EXCLUSIVE lock while
-- it builds. That's acceptable here: user_devices is small (one row per user
-- per device). CONCURRENTLY is intentionally NOT used — Prisma runs each
-- migration inside a transaction, and CREATE INDEX CONCURRENTLY cannot run in
-- one. Revisit with a non-transactional migration only if this table grows large.
CREATE INDEX "user_devices_fingerprint_idx" ON "user_devices"("fingerprint");
