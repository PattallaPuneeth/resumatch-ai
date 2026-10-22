-- Phase 2A: Storage, Status State Machine, and Parsed Resume Hazards

-- 1. Create Enums
DO $$ BEGIN
    CREATE TYPE "ResumeStatus" AS ENUM ('UPLOAD_PENDING', 'UPLOADED', 'EXTRACTING', 'NEEDS_OCR', 'OCR_PROCESSING', 'PARSED', 'FAILED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ExtractionMethod" AS ENUM ('TEXT_LAYER', 'OCR', 'DOCX');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Rename existing columns on "resumes" to preserve data if migrating from Phase 1
DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'resumes' AND column_name = 'filename') THEN
        ALTER TABLE "resumes" RENAME COLUMN "filename" TO "originalFilename";
    END IF;
END $$;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'resumes' AND column_name = 's3Key') THEN
        ALTER TABLE "resumes" RENAME COLUMN "s3Key" TO "storageKey";
    END IF;
END $$;

-- Ensure columns exist
ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "originalFilename" TEXT NOT NULL DEFAULT '';
ALTER TABLE "resumes" ALTER COLUMN "originalFilename" DROP DEFAULT;

ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "storageKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "resumes" ALTER COLUMN "storageKey" DROP DEFAULT;

ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "sha256" TEXT;
ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "extractionMethod" "ExtractionMethod";
ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "errorCode" TEXT;
ALTER TABLE "resumes" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;

-- 3. Migration rule: map existing PROCESSING rows to EXTRACTING per Section 5.2
UPDATE "resumes" SET "status" = 'EXTRACTING' WHERE "status" = 'PROCESSING';

-- 4. Convert status column to ResumeStatus enum
ALTER TABLE "resumes" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "resumes" ALTER COLUMN "status" TYPE "ResumeStatus" USING ("status"::text::"ResumeStatus");
ALTER TABLE "resumes" ALTER COLUMN "status" SET DEFAULT 'UPLOADED';

-- 5. Create unique constraint and index on "resumes"
CREATE UNIQUE INDEX IF NOT EXISTS "resumes_storageKey_key" ON "resumes"("storageKey");
CREATE INDEX IF NOT EXISTS "resumes_status_idx" ON "resumes"("status");

-- 6. Add pageCount and atsHazards to "parsed_resumes"
ALTER TABLE "parsed_resumes" ADD COLUMN IF NOT EXISTS "pageCount" INTEGER;
ALTER TABLE "parsed_resumes" ADD COLUMN IF NOT EXISTS "atsHazards" JSONB;
