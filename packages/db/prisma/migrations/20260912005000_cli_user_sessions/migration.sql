CREATE TABLE "cli_user_tokens" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cli_user_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cli_user_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "cli_user_tokens_tokenHash_key" ON "cli_user_tokens"("tokenHash");
CREATE INDEX "cli_user_tokens_userId_idx" ON "cli_user_tokens"("userId");
ALTER TABLE "org_api_tokens" ADD COLUMN "cliUserTokenId" TEXT;
ALTER TABLE "org_api_tokens" ADD CONSTRAINT "org_api_tokens_cliUserTokenId_fkey" FOREIGN KEY ("cliUserTokenId") REFERENCES "cli_user_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "org_api_tokens_cliUserTokenId_organizationId_key" ON "org_api_tokens"("cliUserTokenId", "organizationId");
ALTER TABLE "cli_auth_sessions" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'organization';
