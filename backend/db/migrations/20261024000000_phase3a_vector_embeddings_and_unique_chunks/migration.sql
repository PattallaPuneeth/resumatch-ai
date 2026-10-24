-- Phase 3A: Vector Embeddings and Chunk Unique Indexes

-- 1. Ensure pgvector extension is enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Ensure embedding columns exist as vector(384)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'resume_chunks' AND column_name = 'embedding'
    ) THEN
        ALTER TABLE "resume_chunks" ADD COLUMN "embedding" vector(384);
    END IF;
END $$;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'job_chunks' AND column_name = 'embedding'
    ) THEN
        ALTER TABLE "job_chunks" ADD COLUMN "embedding" vector(384);
    END IF;
END $$;

-- 3. Ensure HNSW Cosine Similarity Indexes exist
CREATE INDEX IF NOT EXISTS "resume_chunks_embedding_hnsw_idx"
ON "resume_chunks" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "job_chunks_embedding_hnsw_idx"
ON "job_chunks" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- 4. Enforce Database Idempotency: Composite Unique Constraints
-- Prevents duplicate chunks on retries or concurrent job deliveries
CREATE UNIQUE INDEX IF NOT EXISTS "resume_chunks_resumeId_chunkIndex_key"
ON "resume_chunks"("resumeId", "chunkIndex");

CREATE UNIQUE INDEX IF NOT EXISTS "job_chunks_jobId_chunkIndex_key"
ON "job_chunks"("jobId", "chunkIndex");
