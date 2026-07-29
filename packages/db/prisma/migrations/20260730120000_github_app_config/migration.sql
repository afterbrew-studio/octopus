-- Self-hosted GitHub App config (App Manifest flow, #self-host). Additive and
-- nullable — safe on live and a no-op on cloud (columns stay null; the resolver
-- falls back to the GITHUB_APP_* env vars). Secret columns hold ciphertext.

-- AlterTable
ALTER TABLE "system_config" ADD COLUMN     "githubAppClientId" TEXT,
ADD COLUMN     "githubAppClientSecretEnc" TEXT,
ADD COLUMN     "githubAppHtmlUrl" TEXT,
ADD COLUMN     "githubAppId" TEXT,
ADD COLUMN     "githubAppPrivateKeyEnc" TEXT,
ADD COLUMN     "githubAppSlug" TEXT,
ADD COLUMN     "githubAppWebhookSecretEnc" TEXT;
