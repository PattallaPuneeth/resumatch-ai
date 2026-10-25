"""
Phase 4A: Database Persistence Repository for Structured Analysis.

Provides atomic, idempotent persistence for structured LLM analysis,
mirroring the Match persistence pattern inside a single PostgreSQL transaction.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import psycopg
from ml.config import settings

logger = logging.getLogger("resumatch-ml-analysis-repo")


def get_analysis_context(resume_id: str, job_id: str) -> dict[str, Any] | None:
    """
    Fetches required parsed resume, job, and pre-computed match data for analysis.

    Returns:
        dict with resume, job, and match fields, or None if resume or job is missing.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                # 1. Fetch resume and parsed data
                cur.execute(
                    """
                    SELECT r.status::text, p."rawText", p."candidateName",
                           p.skills, p."atsScore", p."atsHazards"
                    FROM resumes r
                    LEFT JOIN parsed_resumes p ON p."resumeId" = r.id
                    WHERE r.id = %s;
                    """,
                    (resume_id,),
                )
                r_row = cur.fetchone()
                if not r_row:
                    logger.info("Resume %s not found for analysis", resume_id)
                    return None

                # 2. Fetch job data
                cur.execute(
                    """
                    SELECT id, title, company, "rawDescription", "requiredSkills", status
                    FROM jobs
                    WHERE id = %s;
                    """,
                    (job_id,),
                )
                j_row = cur.fetchone()
                if not j_row:
                    logger.info("Job %s not found for analysis", job_id)
                    return None

                # 3. Fetch pre-computed match data (from Phase 3B/3C)
                cur.execute(
                    """
                    SELECT id, "finalScore", explanation
                    FROM matches
                    WHERE "resumeId" = %s AND "jobId" = %s;
                    """,
                    (resume_id, job_id),
                )
                m_row = cur.fetchone()

                return {
                    "resume_status": r_row[0],
                    "raw_text": r_row[1] or "",
                    "candidate_name": r_row[2],
                    "resume_skills": r_row[3],
                    "ats_score": r_row[4],
                    "ats_hazards": r_row[5],
                    "job_id": j_row[0],
                    "job_title": j_row[1],
                    "job_company": j_row[2],
                    "job_description": j_row[3] or "",
                    "job_required_skills": j_row[4],
                    "job_status": j_row[5],
                    "match_id": m_row[0] if m_row else None,
                    "match_final_score": float(m_row[1])
                    if m_row and m_row[1] is not None
                    else None,
                    "match_explanation": m_row[2] if m_row else None,
                }
    except Exception as e:
        logger.error(
            "Failed to query analysis context for resume %s and job %s: %s",
            resume_id,
            job_id,
            e,
        )
        raise


def persist_analysis_result(
    resume_id: str,
    job_id: str,
    result: dict[str, Any],
    llm_status: str,
    provider: str | None = None,
    model: str | None = None,
    prompt_version: str | None = None,
    tokens_prompt: int = 0,
    tokens_completion: int = 0,
    latency_ms: int = 0,
    fabricated_evidence_rate: float = 0.0,
    injection_suspected: bool = False,
    score: float | None = None,
    skill_gap: dict[str, Any] | None = None,
    ats_findings: dict[str, Any] | None = None,
    status: str = "COMPLETED",
) -> str:
    """
    Atomically persists structured analysis results to the analyses table.
    Uses ON CONFLICT ("resumeId", "jobId") DO UPDATE to guarantee idempotency on retries.

    Returns:
        The Analysis record UUID.
    """
    try:
        result_json = json.dumps(result)
        skill_gap_json = json.dumps(skill_gap) if skill_gap is not None else None
        ats_findings_json = json.dumps(ats_findings) if ats_findings is not None else None

        with psycopg.connect(settings.database_url) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO analyses (
                            id, "resumeId", "jobId", score, "skillGap", "atsFindings",
                            status, result, "llmStatus", provider,
                            model, "promptVersion", "tokensPrompt", "tokensCompletion",
                            "latencyMs", "fabricatedEvidenceRate", "injectionSuspected",
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(), %s, %s, %s, %s::jsonb, %s::jsonb,
                            %s, %s::jsonb, %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s,
                            NOW(), NOW()
                        )
                        ON CONFLICT ("resumeId", "jobId") DO UPDATE SET
                            score = EXCLUDED.score,
                            "skillGap" = EXCLUDED."skillGap",
                            "atsFindings" = EXCLUDED."atsFindings",
                            status = EXCLUDED.status,
                            result = EXCLUDED.result,
                            "llmStatus" = EXCLUDED."llmStatus",
                            provider = EXCLUDED.provider,
                            model = EXCLUDED.model,
                            "promptVersion" = EXCLUDED."promptVersion",
                            "tokensPrompt" = EXCLUDED."tokensPrompt",
                            "tokensCompletion" = EXCLUDED."tokensCompletion",
                            "latencyMs" = EXCLUDED."latencyMs",
                            "fabricatedEvidenceRate" = EXCLUDED."fabricatedEvidenceRate",
                            "injectionSuspected" = EXCLUDED."injectionSuspected",
                            "updatedAt" = NOW()
                        RETURNING id;
                        """,
                        (
                            resume_id,
                            job_id,
                            score,
                            skill_gap_json,
                            ats_findings_json,
                            status,
                            result_json,
                            llm_status,
                            provider,
                            model,
                            prompt_version,
                            tokens_prompt,
                            tokens_completion,
                            latency_ms,
                            fabricated_evidence_rate,
                            injection_suspected,
                        ),
                    )
                    row = cur.fetchone()
                    if not row:
                        raise RuntimeError("Failed to insert or update analysis record")
                    analysis_id = str(row[0])

        logger.info(
            "Successfully persisted Analysis %s for resume %s and job %s with llmStatus %s",
            analysis_id,
            resume_id,
            job_id,
            llm_status,
        )
        return analysis_id

    except Exception as e:
        logger.exception(
            "Failed to persist analysis result for resume %s and job %s: %s",
            resume_id,
            job_id,
            e,
        )
        raise


def mark_analysis_failed(
    resume_id: str,
    job_id: str,
    error_message: str,
) -> None:
    """
    Records a terminal failure in the analyses table without storing fake success data.
    """
    try:
        err_json = json.dumps({"error": error_message})
        with psycopg.connect(settings.database_url) as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO analyses (
                            id, "resumeId", "jobId", status, result, "llmStatus",
                            "createdAt", "updatedAt"
                        ) VALUES (
                            gen_random_uuid(), %s, %s, 'FAILED', %s::jsonb, 'FAILED',
                            NOW(), NOW()
                        )
                        ON CONFLICT ("resumeId", "jobId") DO UPDATE SET
                            status = 'FAILED',
                            result = EXCLUDED.result,
                            "llmStatus" = 'FAILED',
                            "updatedAt" = NOW();
                        """,
                        (resume_id, job_id, err_json),
                    )
        logger.warning(
            "Marked analysis as FAILED for resume %s and job %s: %s",
            resume_id,
            job_id,
            error_message,
        )
    except Exception as e:
        logger.exception("Failed to mark analysis failed: %s", e)
