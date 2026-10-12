-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable users
CREATE TABLE IF NOT EXISTS "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT,
    "fullName" TEXT,
    "role" TEXT NOT NULL DEFAULT 'CANDIDATE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable resumes
CREATE TABLE IF NOT EXISTS "resumes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable parsed_resumes
CREATE TABLE IF NOT EXISTS "parsed_resumes" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "candidateName" TEXT,
    "contactInfo" JSONB,
    "summary" TEXT,
    "skills" JSONB,
    "experience" JSONB,
    "education" JSONB,
    "certifications" JSONB,
    "atsScore" DOUBLE PRECISION,
    "parsingMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parsed_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable resume_chunks
CREATE TABLE IF NOT EXISTS "resume_chunks" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "sectionType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(384),
    "tokenCount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable jobs
CREATE TABLE IF NOT EXISTS "jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "jobType" TEXT,
    "rawDescription" TEXT NOT NULL,
    "requiredSkills" JSONB,
    "preferredSkills" JSONB,
    "experienceLevel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable job_chunks
CREATE TABLE IF NOT EXISTS "job_chunks" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "sectionType" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(384),
    "tokenCount" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable analyses
CREATE TABLE IF NOT EXISTS "analyses" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jobId" TEXT,
    "score" DOUBLE PRECISION,
    "skillGap" JSONB,
    "atsFindings" JSONB,
    "bulletRewrites" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable matches
CREATE TABLE IF NOT EXISTS "matches" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "bm25Score" DOUBLE PRECISION,
    "vectorScore" DOUBLE PRECISION,
    "rrfScore" DOUBLE PRECISION,
    "crossEncoderScore" DOUBLE PRECISION,
    "finalScore" DOUBLE PRECISION NOT NULL,
    "explanation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable audit_logs
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes & Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users"("email");
CREATE INDEX IF NOT EXISTS "resumes_userId_idx" ON "resumes"("userId");
CREATE INDEX IF NOT EXISTS "resumes_status_idx" ON "resumes"("status");
CREATE UNIQUE INDEX IF NOT EXISTS "parsed_resumes_resumeId_key" ON "parsed_resumes"("resumeId");
CREATE INDEX IF NOT EXISTS "resume_chunks_resumeId_idx" ON "resume_chunks"("resumeId");
CREATE INDEX IF NOT EXISTS "jobs_userId_idx" ON "jobs"("userId");
CREATE INDEX IF NOT EXISTS "jobs_status_idx" ON "jobs"("status");
CREATE INDEX IF NOT EXISTS "job_chunks_jobId_idx" ON "job_chunks"("jobId");
CREATE INDEX IF NOT EXISTS "analyses_resumeId_idx" ON "analyses"("resumeId");
CREATE INDEX IF NOT EXISTS "analyses_jobId_idx" ON "analyses"("jobId");
CREATE INDEX IF NOT EXISTS "matches_resumeId_idx" ON "matches"("resumeId");
CREATE INDEX IF NOT EXISTS "matches_jobId_idx" ON "matches"("jobId");
CREATE UNIQUE INDEX IF NOT EXISTS "matches_resumeId_jobId_key" ON "matches"("resumeId", "jobId");
CREATE INDEX IF NOT EXISTS "audit_logs_userId_idx" ON "audit_logs"("userId");
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx" ON "audit_logs"("action");
CREATE INDEX IF NOT EXISTS "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- Foreign Keys
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "parsed_resumes" ADD CONSTRAINT "parsed_resumes_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "resume_chunks" ADD CONSTRAINT "resume_chunks_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job_chunks" ADD CONSTRAINT "job_chunks_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "matches" ADD CONSTRAINT "matches_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "matches" ADD CONSTRAINT "matches_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HNSW Vector Similarity Indexes (Cosine metric for 384 dimensions)
CREATE INDEX IF NOT EXISTS "resume_chunks_embedding_hnsw_idx"
ON "resume_chunks" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS "job_chunks_embedding_hnsw_idx"
ON "job_chunks" USING hnsw ("embedding" vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

-- Full-Text GIN Indexes (BM25 Hybrid Search Support)
CREATE INDEX IF NOT EXISTS "resume_chunks_content_tsv_idx"
ON "resume_chunks" USING gin (to_tsvector('english', "content"));

CREATE INDEX IF NOT EXISTS "job_chunks_content_tsv_idx"
ON "job_chunks" USING gin (to_tsvector('english', "content"));

CREATE INDEX IF NOT EXISTS "parsed_resumes_raw_text_tsv_idx"
ON "parsed_resumes" USING gin (to_tsvector('english', "rawText"));

CREATE INDEX IF NOT EXISTS "jobs_raw_desc_tsv_idx"
ON "jobs" USING gin (to_tsvector('english', "rawDescription"));
