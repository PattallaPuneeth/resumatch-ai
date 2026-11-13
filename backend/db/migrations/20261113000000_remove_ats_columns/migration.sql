-- Item 4: ATS scoring, hazards and findings are removed from the product.
ALTER TABLE "parsed_resumes" DROP COLUMN IF EXISTS "atsScore";
ALTER TABLE "parsed_resumes" DROP COLUMN IF EXISTS "atsHazards";
ALTER TABLE "analyses" DROP COLUMN IF EXISTS "atsFindings";
