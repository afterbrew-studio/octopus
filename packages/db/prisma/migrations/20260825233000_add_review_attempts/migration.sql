-- CreateTable
CREATE TABLE "review_attempts" (
    "id" TEXT NOT NULL,
    "correlationId" TEXT,
    "source" TEXT NOT NULL,
    "headSha" TEXT,
    "provider" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "terminalAt" TIMESTAMP(3),
    "terminalDetail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pullRequestId" TEXT NOT NULL,

    CONSTRAINT "review_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "review_attempts_pullRequestId_createdAt_idx" ON "review_attempts"("pullRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "review_attempts_state_idx" ON "review_attempts"("state");

-- AddForeignKey
ALTER TABLE "review_attempts" ADD CONSTRAINT "review_attempts_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

