import json
import logging

import psycopg
from ml.config import settings
from ml.pipelines.intake.models import DocumentParseResult
from ml.pipelines.intake.state_machine import evaluate_resume_transition

logger = logging.getLogger("resumatch-ml-repository")


def update_resume_status(
    resume_id: str,
    status: str,
    extraction_method: str | None = None,
) -> bool:
    """
    Updates status and optionally extractionMethod of a resume record,
    guarded by the central state machine.
    Returns False if resume not found or transition is rejected.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM resumes WHERE id = %s FOR UPDATE;",
                    (resume_id,),
                )
                row = cur.fetchone()
                if not row:
                    return False
                current_status = row[0]
                eval_res = evaluate_resume_transition(current_status, status)
                if eval_res.is_noop:
                    return True
                if not eval_res.allowed:
                    logger.warning(
                        "Rejected invalid state transition for resume %s: %s "
                        "(current=%s, requested=%s)",
                        resume_id,
                        eval_res.reason,
                        current_status,
                        status,
                    )
                    return False

                if extraction_method:
                    cur.execute(
                        """
                        UPDATE resumes
                        SET status = %s::"ResumeStatus",
                            "extractionMethod" = %s::"ExtractionMethod",
                            "updatedAt" = NOW()
                        WHERE id = %s;
                        """,
                        (status, extraction_method, resume_id),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE resumes
                        SET status = %s::"ResumeStatus",
                            "updatedAt" = NOW()
                        WHERE id = %s;
                        """,
                        (status, resume_id),
                    )
                rowcount = cur.rowcount
                conn.commit()
                return rowcount > 0
    except Exception as e:
        logger.error("Failed to update status to %s for resume %s: %s", status, resume_id, e)
        raise


def mark_resume_failed(resume_id: str, error_code: str, error_message: str) -> bool:
    """
    Transitions resume to FAILED status with user-safe error code and message.
    Guarded by state machine: no-op if already FAILED; rejected if already PARSED.
    Returns False if resume not found or transition is rejected.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT status FROM resumes WHERE id = %s FOR UPDATE;",
                    (resume_id,),
                )
                row = cur.fetchone()
                if not row:
                    return False
                current_status = row[0]
                eval_res = evaluate_resume_transition(current_status, "FAILED")
                if eval_res.is_noop:
                    return True
                if not eval_res.allowed:
                    logger.warning(
                        "Cannot mark resume %s as FAILED: already in terminal status %s",
                        resume_id,
                        current_status,
                    )
                    return False

                cur.execute(
                    """
                    UPDATE resumes
                    SET status = 'FAILED'::"ResumeStatus",
                        "errorCode" = %s,
                        "errorMessage" = %s,
                        "updatedAt" = NOW()
                    WHERE id = %s;
                    """,
                    (error_code, error_message, resume_id),
                )
                rowcount = cur.rowcount
                conn.commit()
                if rowcount > 0:
                    logger.info("Marked resume %s as FAILED (code=%s)", resume_id, error_code)
                else:
                    logger.warning(
                        "Resume %s not found when marking FAILED (possibly deleted)", resume_id
                    )
                return rowcount > 0
    except Exception as e:
        logger.error("Failed to mark resume %s as failed: %s", resume_id, e)
        raise


def save_parsed_resume(resume_id: str, parse_result: DocumentParseResult) -> bool:
    """
    Persists extracted resume data into parsed_resumes and marks resume as PARSED.
    Idempotent: uses ON CONFLICT ("resumeId") DO UPDATE to prevent duplicate rows.
    Returns False if resume was deleted prior to persistence.
    """
    contact_dict = parse_result.contact.model_dump(exclude_none=True)
    skills_list = [s.model_dump(exclude_none=True) for s in parse_result.skills]
    experience_list = [e.model_dump(exclude_none=True) for e in parse_result.experience]
    education_list = [ed.model_dump(exclude_none=True) for ed in parse_result.education]
    hazards_list = [h.model_dump() for h in parse_result.ats_hazards]

    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                # 1. Update Resume status and extraction method
                cur.execute(
                    """
                    UPDATE resumes
                    SET status = 'PARSED'::"ResumeStatus",
                        "extractionMethod" = %s::"ExtractionMethod",
                        "errorCode" = NULL,
                        "errorMessage" = NULL,
                        "updatedAt" = NOW()
                    WHERE id = %s;
                    """,
                    (parse_result.extraction_method, resume_id),
                )
                if cur.rowcount == 0:
                    logger.warning(
                        "Resume %s not found (deleted); aborting parsed data persistence",
                        resume_id,
                    )
                    return False

                # 2. Upsert into parsed_resumes
                cur.execute(
                    """
                    INSERT INTO parsed_resumes (
                        id,
                        "resumeId",
                        "rawText",
                        "candidateName",
                        "contactInfo",
                        summary,
                        skills,
                        experience,
                        education,
                        certifications,
                        "pageCount",
                        "atsScore",
                        "atsHazards",
                        "parsingMetadata",
                        "createdAt",
                        "updatedAt"
                    ) VALUES (
                        gen_random_uuid(),
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        NOW(),
                        NOW()
                    )
                    ON CONFLICT ("resumeId") DO UPDATE SET
                        "rawText" = EXCLUDED."rawText",
                        "candidateName" = EXCLUDED."candidateName",
                        "contactInfo" = EXCLUDED."contactInfo",
                        summary = EXCLUDED.summary,
                        skills = EXCLUDED.skills,
                        experience = EXCLUDED.experience,
                        education = EXCLUDED.education,
                        certifications = EXCLUDED.certifications,
                        "pageCount" = EXCLUDED."pageCount",
                        "atsScore" = EXCLUDED."atsScore",
                        "atsHazards" = EXCLUDED."atsHazards",
                        "parsingMetadata" = EXCLUDED."parsingMetadata",
                        "updatedAt" = NOW();
                    """,
                    (
                        resume_id,
                        parse_result.raw_text,
                        parse_result.candidate_name,
                        json.dumps(contact_dict),
                        parse_result.summary,
                        json.dumps(skills_list),
                        json.dumps(experience_list),
                        json.dumps(education_list),
                        json.dumps([]),  # certifications
                        parse_result.page_count,
                        parse_result.ats_score,
                        json.dumps(hazards_list),
                        json.dumps(parse_result.parsing_metadata),
                    ),
                )
                conn.commit()
        logger.info(
            "Successfully saved parsed resume for %s (method=%s, ats_score=%.1f)",
            resume_id,
            parse_result.extraction_method,
            parse_result.ats_score,
        )
        return True
    except Exception as e:
        logger.error("Failed to save parsed resume for %s: %s", resume_id, e)
        raise


def get_resume_status(resume_id: str) -> tuple[str | None, str | None]:
    """Returns (status, extractionMethod) for a resume, or (None, None) if not found."""
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT status, "extractionMethod" FROM resumes WHERE id = %s;',
                    (resume_id,),
                )
                row = cur.fetchone()
                if not row:
                    return (None, None)
                return (str(row[0]), str(row[1]) if row[1] else None)
    except Exception as e:
        logger.error("Failed to fetch status for resume %s: %s", resume_id, e)
        raise
