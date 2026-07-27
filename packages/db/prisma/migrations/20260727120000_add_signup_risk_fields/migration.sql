-- Signup abuse-prevention fields (expand-only, all nullable — safe on live).
ALTER TABLE "users" ADD COLUMN "signupIp" TEXT;
ALTER TABLE "users" ADD COLUMN "welcomeGrantedAt" TIMESTAMP(3);

ALTER TABLE "organizations" ADD COLUMN "welcomeRiskScore" INTEGER;
ALTER TABLE "organizations" ADD COLUMN "welcomeRiskReason" TEXT;
