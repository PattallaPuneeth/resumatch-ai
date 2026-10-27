"""
Phase 7: Candidate Job Listing Scorer.

Scores scraped or discovered job listings against a parsed resume using
the existing deterministic Phase 3 matching pipeline:
- Sparse BM25 lexical search (search_lexical)
- Dense semantic vector search (search_semantic)
- Reciprocal Rank Fusion (fuse_ranks)
- Cross-Encoder reranking (rerank_candidates)
- Skill-gap analysis (analyze_skill_gap)
- Calibrated composite blend (compute_match_scores)

Zero LLM calls are made; match scores and rankings are purely deterministic.
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg
from ml.config import settings
from ml.pipelines.matching.lexical import search_lexical
from ml.pipelines.matching.reranker import build_bounded_rerank_query, rerank_candidates
from ml.pipelines.matching.rrf import fuse_ranks
from ml.pipelines.matching.scorer import compute_match_scores
from ml.pipelines.matching.semantic import search_semantic
from ml.pipelines.matching.skill_gap import (
  analyze_skill_gap,
  extract_skills_from_text,
)
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("resumatch-ml-suggestions-scorer")


class CandidateListingItem(BaseModel):
  model_config = ConfigDict(populate_by_name=True)

  id: str = ""
  title: str
  company: str = ""
  location: str | None = None
  description: str
  required_skills: list[str] = Field(default_factory=list, alias="requiredSkills")
  source_url: str | None = Field(default=None, alias="sourceUrl")


class ScoreCandidateListingsRequest(BaseModel):
  model_config = ConfigDict(populate_by_name=True)

  resume_id: str = Field(..., alias="resumeId")
  listings: list[CandidateListingItem]


class ScoredCandidateListing(BaseModel):
  model_config = ConfigDict(populate_by_name=True)

  id: str
  title: str
  company: str
  location: str | None = None
  source_url: str | None = Field(default=None, alias="sourceUrl")
  match_score: float = Field(..., alias="matchScore")
  matched_skills: list[str] = Field(
      default_factory=list, alias="matchedSkills"
  )
  missing_skills: list[str] = Field(
      default_factory=list, alias="missingSkills"
  )


class ScoreCandidateListingsResponse(BaseModel):
  model_config = ConfigDict(populate_by_name=True)

  resume_id: str = Field(..., alias="resumeId")
  total_scored: int = Field(..., alias="totalScored")
  results: list[ScoredCandidateListing]





def get_resume_context(resume_id: str) -> dict[str, Any] | None:
  """Fetches status and skills for a resume."""
  try:
    with psycopg.connect(settings.database_url) as conn:
      with conn.cursor() as cur:
        cur.execute(
            """
                    SELECT r.status::text, p.skills, p.summary, p."rawText"
                    FROM resumes r
                    LEFT JOIN parsed_resumes p ON p."resumeId" = r.id
                    WHERE r.id = %s;
                    """,
            (resume_id,),
        )
        row = cur.fetchone()
        if not row:
          return None
        return {
            "status": row[0],
            "skills": row[1],
            "summary": row[2],
            "raw_text": row[3],
        }
  except Exception as e:
    logger.error("Failed to fetch resume context for %s: %s", resume_id, e)
    raise


class SuggestionsScoringService:
  """Service for scoring candidate job listings against a resume."""

  def score_listings(
      self, request: ScoreCandidateListingsRequest
  ) -> ScoreCandidateListingsResponse:
    resume_id = request.resume_id
    ctx = get_resume_context(resume_id)
    if not ctx:
      raise ValueError(f"Resume {resume_id} not found")

    if ctx.get("status") != "PARSED":
      raise ValueError(
          f"Resume {resume_id} status is {ctx.get('status')} (must be PARSED)"
      )

    resume_skills = ctx.get("skills")
    resume_text = ctx.get("raw_text") or ""
    scored_items: list[ScoredCandidateListing] = []

    for listing in request.listings:
      title = listing.title.strip()
      company = listing.company.strip()
      description = listing.description.strip()
      req_skills = list(listing.required_skills)

      # If required_skills not provided, extract from description
      if not req_skills:
        req_skills = extract_skills_from_text(f"{title}\n{description}")

      query_text = f"{title}\n{' '.join(req_skills)}\n{description}".strip()

      # 1. Sparse Lexical Search on resume_chunks
      lexical_hits = search_lexical(query_text, resume_id=resume_id, limit=30)

      # 2. Dense Semantic Search on resume_chunks
      semantic_hits = search_semantic(
          query_text, resume_id=resume_id, limit=30
      )

      # 3. Reciprocal Rank Fusion
      fused_chunks = fuse_ranks(lexical_hits, semantic_hits, k=settings.rrf_k)

      # 4. Cross-Encoder Reranking
      job_rerank_query = build_bounded_rerank_query(
          title, req_skills, description, max_tokens=180
      )
      reranked_chunks = rerank_candidates(
          job_rerank_query, fused_chunks, top_n=settings.top_k_candidates
      )

      # 5. Skill-Gap Analysis
      skill_gap = analyze_skill_gap(req_skills, resume_skills, resume_text=resume_text)

      # 6. Composite scoring
      scores = compute_match_scores(
          lexical_hits=lexical_hits,
          semantic_hits=semantic_hits,
          reranked_chunks=reranked_chunks,
          skill_gap=skill_gap,
      )

      scored_items.append(
          ScoredCandidateListing(
              id=listing.id,
              title=title,
              company=company,
              location=listing.location,
              source_url=listing.source_url,
              match_score=scores["final_score"],
              matched_skills=skill_gap.get("matched", []),
              missing_skills=skill_gap.get("missing", []),
          )
      )

    # Sort results by matchScore descending
    scored_items.sort(key=lambda x: x.match_score, reverse=True)

    return ScoreCandidateListingsResponse(
        resume_id=resume_id,
        total_scored=len(scored_items),
        results=scored_items,
    )
