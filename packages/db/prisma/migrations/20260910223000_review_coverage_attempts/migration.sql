ALTER TABLE "pull_requests" ADD COLUMN "reviewCoverage" JSONB;
CREATE TABLE "review_attempts" (
  "id" TEXT NOT NULL,
  "pullRequestId" TEXT NOT NULL,
  "headSha" TEXT,
  "baseSha" TEXT,
  "coverage" JSONB NOT NULL,
  "reviewBody" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_attempts_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "review_attempts_pullRequestId_createdAt_idx" ON "review_attempts"("pullRequestId", "createdAt");
