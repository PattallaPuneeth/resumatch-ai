-- Store the Item 1 Resume + JD assessment separately from retrieval/ranking scores.
ALTER TABLE "matches"
ADD COLUMN IF NOT EXISTS "item1Result" JSONB;
