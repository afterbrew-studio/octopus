CREATE TABLE "review_attempt_deliveries" (
    "attemptId" TEXT NOT NULL,
    "mainCommentId" BIGINT,
    "summaryPublished" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    CONSTRAINT "review_attempt_deliveries_pkey" PRIMARY KEY ("attemptId"),
    CONSTRAINT "review_attempt_deliveries_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "review_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
