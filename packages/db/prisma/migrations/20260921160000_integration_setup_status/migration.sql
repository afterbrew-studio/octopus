ALTER TABLE "organizations" ADD COLUMN "githubSetupStatus" JSONB;
ALTER TABLE "repositories" ADD COLUMN "webhookSetupStatus" JSONB;
ALTER TABLE "bitbucket_integrations" ADD COLUMN "setupStatus" JSONB;
ALTER TABLE "gitlab_integrations" ADD COLUMN "setupStatus" JSONB;
ALTER TABLE "forgejo_integrations" ADD COLUMN "setupStatus" JSONB;
