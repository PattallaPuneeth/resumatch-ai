"""
Phase 3B: Database Persistence Repository for Matches.

Provides atomic, idempotent persistence for match scoring results, component scores,
and skill-gap explanations inside a single PostgreSQL transaction.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg
from ml.config import settings

logger = logging.getLogger("resumatch-ml-matching-repo")


class MatchTargetGoneError(Exception):
    """The resume or job of a queued match was deleted before the result could be saved."""


def get_match_context(resume_id: str, job_id: str) -> dict[str, Any] | None:
    """
    Fetches required resume and job data for match calculation.

    Returns:
        dict with resume and job fields, or None if either does not exist.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                # 1. Fetch resume and parsed data
                cur.execute(
                    """
                    SELECT r.status::text, p.skills, p.summary, p."rawText"
                    FROM resumes r
                    LEFT JOIN parsed_resumes p ON p."resumeId" = r.id
                    WHERE r.id = %s;
                    """,
                    (resume_id,),
                )
                r_row = cur.fetchone()
                if not r_row:
                    logger.info("Resume %s not found for match calculation", resume_id)
                    return None

                # 2. Fetch job data
                cur.execute(
                    """
                    SELECT id, title, company, "rawDescription", "requiredSkills", status,
                           "preferredSkills"
                    FROM jobs
                    WHERE id = %s;
                    """,
                    (job_id,),
                )
                j_row = cur.fetchone()
                if not j_row:
                    logger.info("Job %s not found for match calculation", job_id)
                    return None

                return {
                    "resume_status": r_row[0],
                    "resume_skills": r_row[1],
                    "resume_summary": r_row[2],
                    "resume_raw_text": r_row[3],
                    "job_id": j_row[0],
                    "job_title": j_row[1],
                    "job_company": j_row[2],
                    "job_description": j_row[3],
                    "job_required_skills": j_row[4],
                    "job_status": j_row[5],
                    "job_preferred_skills": j_row[6],
                }
    except Exception as e:
        logger.error(
            "Failed to query match context for resume %s and job %s: %s", resume_id, job_id, e
        )
        raise


def persist_match_result(
    resume_id: str,
    job_id: str,
    bm25_score: float | None = None,
    vector_score: float | None = None,
    rrf_score: float | None = None,
    cross_encoder_score: float | None = None,
    final_score: float = 0.0,
    explanation: dict[str, Any] | None = None,
    **kwargs: Any,
) -> str:
    """
    Atomically persists match calculation results to the matches table.
    Uses ON CONFLICT ("resumeId", "jobId") DO UPDATE to guarantee idempotency on retries.

    Returns:
        The Match record UUID.
    """
    try:
        if bm25_score is None and "lexical_score" in kwargs:
            bm25_score = kwargs["lexical_score"]
        if vector_score is None and "semantic_score" in kwargs:
            vector_score = kwargs["semantic_score"]
        if explanation is None:
            explanation = {}

        explanation_json = json.dumps(explanation)

        with psycopg.connect(settings.database_url) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO matches (
                            id, "resumeId", "jobId", "bm25Score", "vectorScore",
                            "rrfScore", "crossEncoderScore", "finalScore", explanation,
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s::jsonb,
                            NOW(), NOW()
                        )
                        ON CONFLICT ("resumeId", "jobId") DO UPDATE SET
                            "bm25Score" = EXCLUDED."bm25Score",
                            "vectorScore" = EXCLUDED."vectorScore",
                            "rrfScore" = EXCLUDED."rrfScore",
                            "crossEncoderScore" = EXCLUDED."crossEncoderScore",
                            "finalScore" = EXCLUDED."finalScore",
                            "explanation" = EXCLUDED."explanation",
                            "updatedAt" = NOW()
                        RETURNING id;
                        """,
                        (
                            resume_id,
                            job_id,
                            bm25_score,
                            vector_score,
                            rrf_score,
                            cross_encoder_score,
                            final_score,
                            explanation_json,
                        ),
                    )
                    row = cur.fetchone()
                    if not row:
                        raise RuntimeError("Failed to insert or update match record")
                    match_id = str(row[0])

        logger.info(
            "Successfully persisted Match %s for resume %s and job %s with finalScore %.2f",
            match_id,
            resume_id,
            job_id,
            final_score,
        )
        return match_id

    except psycopg.errors.ForeignKeyViolation as e:
        # The resume or job was deleted while this match was queued; nothing to save
        raise MatchTargetGoneError(f"resume {resume_id} or job {job_id} no longer exists") from e
    except Exception as e:
        logger.exception(
            "Failed to persist match result for resume %s and job %s: %s", resume_id, job_id, e
        )
        raise
