CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");
CREATE INDEX "organization_invitations_email_status_expiresAt_idx" ON "organization_invitations"("email", "status", "expiresAt");
