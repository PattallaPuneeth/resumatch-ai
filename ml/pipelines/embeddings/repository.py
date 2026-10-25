"""
Phase 3A: Database Repository for Resume Chunks and Embeddings.

Provides atomic, idempotent persistence of resume chunks and pgvector embeddings
within a single PostgreSQL transaction.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import psycopg
from ml.config import settings
from pgvector.psycopg import register_vector

if TYPE_CHECKING:
    from ml.pipelines.embeddings.chunker import TextChunk

logger = logging.getLogger("resumatch-ml-embeddings-repo")


def get_parsed_resume_data(resume_id: str) -> dict[str, str | None] | None:
    """
    Fetches status and rawText for a resume.
    Returns None if the resume does not exist.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT r.status::text, p."rawText"
                    FROM resumes r
                    LEFT JOIN parsed_resumes p ON p."resumeId" = r.id
                    WHERE r.id = %s;
                    """,
                    (resume_id,),
                )
                row = cur.fetchone()
                if not row:
                    return None
                return {"status": row[0], "rawText": row[1]}
    except Exception as e:
        logger.error("Failed to query parsed resume data for resume %s: %s", resume_id, e)
        raise


def persist_resume_chunks(
    resume_id: str,
    chunk_vectors: list[tuple[TextChunk, list[float]]],
) -> int:
    """
    Atomically persists chunks and vector embeddings for a resume.

    All deletions, insertions, and metadata updates happen within a single
    database transaction to ensure all-or-nothing atomicity.
    Idempotent: replaces any existing chunks cleanly and adheres to the
    unique constraint on ("resumeId", "chunkIndex").

    Returns:
        The number of chunks persisted.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            # Register pgvector type handler for psycopg 3
            register_vector(conn)

            with conn.transaction():
                with conn.cursor() as cur:
                    # 1. Verify resume existence and status under transaction
                    cur.execute(
                        """
                        SELECT status::text FROM resumes WHERE id = %s FOR UPDATE;
                        """,
                        (resume_id,),
                    )
                    status_row = cur.fetchone()
                    if not status_row:
                        logger.warning(
                            "Resume %s not found (deleted) during chunk persistence; aborting",
                            resume_id,
                        )
                        return 0

                    if status_row[0] != "PARSED":
                        logger.warning(
                            "Resume %s status is %s (expected PARSED); "
                            "aborting embedding persistence",
                            resume_id,
                            status_row[0],
                        )
                        return 0

                    # 2. Delete any existing chunks for this resume
                    cur.execute(
                        """
                        DELETE FROM resume_chunks WHERE "resumeId" = %s;
                        """,
                        (resume_id,),
                    )

                    # 3. Insert all chunks and embeddings
                    insert_query = """
                    INSERT INTO resume_chunks (
                        id,
                        "resumeId",
                        "chunkIndex",
                        "sectionType",
                        content,
                        embedding,
                        "tokenCount",
                        metadata,
                        "createdAt"
                    ) VALUES (
                        gen_random_uuid(),
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        NOW()
                    );
                    """

                    for chunk, vector in chunk_vectors:
                        meta_json = json.dumps(chunk.metadata)
                        cur.execute(
                            insert_query,
                            (
                                resume_id,
                                chunk.chunk_index,
                                chunk.section_type,
                                chunk.content,
                                vector,
                                chunk.token_count,
                                meta_json,
                            ),
                        )

                    # 4. Record successful embedding in parsed_resumes metadata
                    embed_meta = json.dumps(
                        {
                            "embeddedAt": datetime.now(UTC).isoformat(),
                            "chunkCount": len(chunk_vectors),
                            "embeddingModel": getattr(
                                settings,
                                "embedding_model_name",
                                "sentence-transformers/all-MiniLM-L6-v2",
                            ),
                            "embeddingDimension": getattr(settings, "embedding_dimension", 384),
                        }
                    )
                    cur.execute(
                        """
                        UPDATE parsed_resumes
                        SET "parsingMetadata" =
                            COALESCE("parsingMetadata", '{}'::jsonb) || %s::jsonb,
                            "updatedAt" = NOW()
                        WHERE "resumeId" = %s;
                        """,
                        (embed_meta, resume_id),
                    )

        logger.info(
            "Successfully persisted %d chunks and vector embeddings for resume %s",
            len(chunk_vectors),
            resume_id,
        )
        return len(chunk_vectors)

    except Exception as e:
        logger.exception(
            "Failed to persist chunks for resume %s; transaction rolled back: %s", resume_id, e
        )
        raise


def record_embedding_error(resume_id: str, error_code: str, error_message: str) -> None:
    """
    Records an embedding failure in parsed_resumes metadata for observability.
    Preserves the PARSED state and existing text extraction while noting embedding failure.
    """
    try:
        err_meta = json.dumps(
            {
                "embeddingError": error_message,
                "embeddingErrorCode": error_code,
                "embeddingFailedAt": datetime.now(UTC).isoformat(),
            }
        )
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE parsed_resumes
                    SET "parsingMetadata" = COALESCE("parsingMetadata", '{}'::jsonb) || %s::jsonb,
                        "updatedAt" = NOW()
                    WHERE "resumeId" = %s;
                    """,
                    (err_meta, resume_id),
                )
                conn.commit()
    except Exception as e:
        logger.error("Failed to record embedding error for resume %s: %s", resume_id, e)


def get_job_data(job_id: str) -> dict[str, Any] | None:
    """Fetches job record for embedding."""
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, title, company, "rawDescription", "requiredSkills", status
                    FROM jobs
                    WHERE id = %s;
                    """,
                    (job_id,),
                )
                row = cur.fetchone()
                if not row:
                    return None
                return {
                    "id": row[0],
                    "title": row[1],
                    "company": row[2],
                    "rawDescription": row[3],
                    "requiredSkills": row[4],
                    "status": row[5],
                }
    except Exception as e:
        logger.error("Failed to query job data for job %s: %s", job_id, e)
        raise


def persist_job_chunks(
    job_id: str,
    chunk_vectors: list[tuple[TextChunk, list[float]]],
) -> int:
    """
    Atomically persists chunks and vector embeddings for a job description.
    All deletions and insertions occur in a single PostgreSQL transaction.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            register_vector(conn)
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT 1 FROM jobs WHERE id = %s FOR UPDATE;",
                        (job_id,),
                    )
                    if cur.fetchone() is None:
                        logger.warning(
                            "Job %s not found (deleted) during chunk persistence; aborting",
                            job_id,
                        )
                        return 0

                    cur.execute('DELETE FROM job_chunks WHERE "jobId" = %s;', (job_id,))

                    for chunk, vector in chunk_vectors:
                        meta_json = json.dumps(chunk.metadata) if chunk.metadata else "{}"
                        cur.execute(
                            """
                            INSERT INTO job_chunks (
                                id, "jobId", "chunkIndex", "sectionType",
                                content, embedding, "tokenCount", metadata, "createdAt"
                            ) VALUES (
                                gen_random_uuid(),
                                %s, %s, %s, %s, %s, %s, %s::jsonb, NOW()
                            );
                            """,
                            (
                                job_id,
                                chunk.chunk_index,
                                chunk.section_type,
                                chunk.content,
                                vector,
                                chunk.token_count,
                                meta_json,
                            ),
                        )

        logger.info(
            "Successfully persisted %d chunks and vector embeddings for job %s",
            len(chunk_vectors),
            job_id,
        )
        return len(chunk_vectors)
    except Exception as e:
        logger.exception(
            "Failed to persist chunks for job %s; transaction rolled back: %s", job_id, e
        )
        raise
