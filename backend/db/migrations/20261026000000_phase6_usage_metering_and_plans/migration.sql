-- CreateTable: plans
CREATE TABLE "plans" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "limits" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("key")
);

-- Seed initial plans: unlimited and demo
INSERT INTO "plans" ("key", "name", "limits", "createdAt", "updatedAt")
VALUES
    ('unlimited', 'Unlimited', '{"analyses": null, "job_suggestions": null, "resume_storage_bytes": null}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('demo', 'Demo', '{"analyses": 10, "job_suggestions": 5, "resume_storage_bytes": 5242880}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- AlterTable: users (add planKey default 'unlimited')
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "planKey" TEXT NOT NULL DEFAULT 'unlimited';

-- AddForeignKey: users -> plans
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_planKey_fkey'
    ) THEN
        ALTER TABLE "users" ADD CONSTRAINT "users_planKey_fkey" FOREIGN KEY ("planKey") REFERENCES "plans"("key") ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;

-- CreateTable: user_usage
CREATE TABLE "user_usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "meter" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "used" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndexes: user_usage
CREATE UNIQUE INDEX "user_usage_userId_meter_period_key" ON "user_usage"("userId", "meter", "period");
CREATE INDEX "user_usage_userId_idx" ON "user_usage"("userId");

-- AddForeignKey: user_usage -> users
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill storage gauge from existing non-failed resumes
INSERT INTO "user_usage" ("id", "userId", "meter", "period", "used", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    "userId",
    'resume_storage_bytes',
    'lifetime',
    COALESCE(SUM("sizeBytes"), 0),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "resumes"
WHERE "status" != 'FAILED'
GROUP BY "userId"
ON CONFLICT ("userId", "meter", "period") DO NOTHING;
