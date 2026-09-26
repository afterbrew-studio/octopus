CREATE TABLE "forgejo_integrations" (
  "id" TEXT NOT NULL,
  "forgejoHost" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "accessTokenEnc" TEXT NOT NULL,
  "webhookSecret" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "organizationId" TEXT NOT NULL,
  CONSTRAINT "forgejo_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "forgejo_integrations_organizationId_key"
  ON "forgejo_integrations"("organizationId");

ALTER TABLE "forgejo_integrations" ADD CONSTRAINT "forgejo_integrations_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
