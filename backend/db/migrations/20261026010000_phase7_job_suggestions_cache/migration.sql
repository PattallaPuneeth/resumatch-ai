-- CreateTable: job_listing_cache
CREATE TABLE IF NOT EXISTS "job_listing_cache" (
    "id" TEXT NOT NULL,
    "urlHash" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "location" TEXT,
    "cleanedText" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_listing_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes: job_listing_cache
CREATE UNIQUE INDEX IF NOT EXISTS "job_listing_cache_urlHash_key" ON "job_listing_cache"("urlHash");
CREATE INDEX IF NOT EXISTS "job_listing_cache_urlHash_idx" ON "job_listing_cache"("urlHash");
CREATE INDEX IF NOT EXISTS "job_listing_cache_expiresAt_idx" ON "job_listing_cache"("expiresAt");
