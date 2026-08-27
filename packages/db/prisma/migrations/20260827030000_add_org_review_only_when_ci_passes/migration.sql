-- Hold a review until the head's checks have passed.
--
-- `organizations`, not `Organization`: the model carries @@map("organizations").
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "reviewOnlyWhenCiPasses" BOOLEAN NOT NULL DEFAULT false;
