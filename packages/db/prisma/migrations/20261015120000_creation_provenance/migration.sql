ALTER TABLE "organizations" ADD COLUMN "creationSource" TEXT, ADD COLUMN "creatorFirstOrganization" BOOLEAN;
ALTER TABLE "users" ADD COLUMN "arrivalSource" TEXT, ADD COLUMN "signupMethod" TEXT;
