ALTER TABLE "forgejo_integrations" ALTER COLUMN "accessTokenEnc" DROP NOT NULL;
ALTER TABLE "forgejo_integrations" ADD COLUMN "connectorTokenHash" TEXT,
  ADD COLUMN "connectorLastSeenAt" TIMESTAMP(3), ADD COLUMN "connectorError" TEXT;
CREATE UNIQUE INDEX "forgejo_integrations_connectorTokenHash_key" ON "forgejo_integrations"("connectorTokenHash");
CREATE TABLE "forgejo_connector_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "integrationId" TEXT NOT NULL REFERENCES "forgejo_integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "method" TEXT NOT NULL,
  "requestEnc" TEXT NOT NULL,
  "responseEnc" TEXT,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'queued',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "forgejo_connector_requests_integrationId_status_createdAt_idx" ON "forgejo_connector_requests"("integrationId", "status", "createdAt");
CREATE INDEX "forgejo_connector_requests_expiresAt_idx" ON "forgejo_connector_requests"("expiresAt");
ALTER TABLE "forgejo_integrations" ADD CONSTRAINT "forgejo_one_transport" CHECK (
  ("accessTokenEnc" IS NOT NULL AND "connectorTokenHash" IS NULL)
  OR ("accessTokenEnc" IS NULL AND "connectorTokenHash" IS NOT NULL)
);
