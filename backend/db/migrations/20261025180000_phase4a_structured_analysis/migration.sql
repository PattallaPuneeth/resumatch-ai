-- Phase 4A: Structured Analysis, LLM Failover Gateway, and Safety Layer Schema Additions
-- Justification: Stores execution result JSON, LLM failover metadata, token counts, latency,
-- verification metrics (fabricatedEvidenceRate, injectionSuspected), and enforces atomic idempotency
-- via unique constraint on (resumeId, jobId).
--
-- Rollback note:
-- DROP INDEX IF EXISTS "analyses_resumeId_jobId_key";
-- ALTER TABLE "analyses" DROP COLUMN IF EXISTS "injectionSuspected",
--                        DROP COLUMN IF EXISTS "fabricatedEvidenceRate",
--                        DROP COLUMN IF EXISTS "latencyMs",
--                        DROP COLUMN IF EXISTS "tokensCompletion",
--                        DROP COLUMN IF EXISTS "tokensPrompt",
--                        DROP COLUMN IF EXISTS "promptVersion",
--                        DROP COLUMN IF EXISTS "model",
--                        DROP COLUMN IF EXISTS "provider",
--                        DROP COLUMN IF EXISTS "llmStatus",
--                        DROP COLUMN IF EXISTS "result";

-- AlterTable analyses
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "result" JSONB;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "llmStatus" TEXT;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "provider" TEXT;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "promptVersion" TEXT;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "tokensPrompt" INTEGER;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "tokensCompletion" INTEGER;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "latencyMs" INTEGER;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "fabricatedEvidenceRate" DOUBLE PRECISION;
ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "injectionSuspected" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "analyses_resumeId_jobId_key" ON "analyses"("resumeId", "jobId");
