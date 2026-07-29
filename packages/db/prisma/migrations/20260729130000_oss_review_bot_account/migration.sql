-- OSS bot-account review mode (#536): a manually-approved allowlist of public
-- repos eligible for server-side, bot-posted reviews, plus a postMode column on
-- community review jobs selecting client-side vs bot-account posting. Additive
-- and safe on live: the new column has a default and the table is new.

-- AlterTable
ALTER TABLE "community_review_jobs" ADD COLUMN     "postMode" TEXT NOT NULL DEFAULT 'action_client';

-- CreateTable
CREATE TABLE "oss_review_allowlist" (
    "id" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "note" TEXT,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oss_review_allowlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oss_review_allowlist_repoFullName_key" ON "oss_review_allowlist"("repoFullName");
