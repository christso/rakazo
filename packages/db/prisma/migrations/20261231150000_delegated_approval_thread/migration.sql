ALTER TABLE "runs" ADD COLUMN "approvalThreadId" TEXT;
CREATE INDEX "runs_approvalThreadId_status_idx" ON "runs"("approvalThreadId", "status");
