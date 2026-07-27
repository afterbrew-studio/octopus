-- Global index on device fingerprint so we can count distinct users sharing
-- one fingerprint (the multi-account / Sybil signal). Expand-only, safe on live.
CREATE INDEX "user_devices_fingerprint_idx" ON "user_devices"("fingerprint");
