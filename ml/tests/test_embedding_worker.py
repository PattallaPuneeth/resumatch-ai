"""
Integration and regression tests for Phase 3A Embedding Worker and Persistence.
Tests idempotency, transaction rollback on failure, uniqueness constraints, and queue triggers.
"""

import uuid

import psycopg
import pytest
from bullmq import Job
from pgvector.psycopg import register_vector

from ml.config import settings
from ml.pipelines.embeddings.chunker import TextChunk
from ml.pipelines.embeddings.repository import (
    persist_resume_chunks,
    record_embedding_error,
)
from ml.worker import process_embed_document


def _create_test_user_and_resume(status: str = "PARSED") -> tuple[str, str]:
    """Helper to insert a test user, resume, and parsed_resume into the database."""
    user_id = str(uuid.uuid4())
    resume_id = str(uuid.uuid4())
    storage_key = f"resumes/{user_id}/{resume_id}.pdf"

    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            # Create user
            cur.execute(
                """
                INSERT INTO users (id, email, role, "createdAt", "updatedAt")
                VALUES (%s, %s, 'CANDIDATE', NOW(), NOW());
                """,
                (user_id, f"test-{user_id[:8]}@example.com"),
            )
            # Create resume
            cur.execute(
                """
                INSERT INTO resumes (
                    id, "userId", "originalFilename", "storageKey", "mimeType",
                    "sizeBytes", status, "createdAt", "updatedAt"
                ) VALUES (
                    %s, %s, 'resume.pdf', %s, 'application/pdf', 2048,
                    %s::"ResumeStatus", NOW(), NOW()
                );
                """,
                (resume_id, user_id, storage_key, status),
            )
            # Create parsed_resume if PARSED
            if status == "PARSED":
                raw_text = (
                    "PROFESSIONAL SUMMARY\nSenior Python engineer specializing in AI.\n\n"
                    "TECHNICAL SKILLS\nPython, PostgreSQL, Redis, Docker, PyTorch, Fastify.\n\n"
                    "WORK EXPERIENCE\nAcme Corp: Lead Backend Architect (2020 - Present).\n"
                    "Engineered distributed indexing pipeline with pgvector embeddings.\n\n"
                    "EDUCATION\nB.S. in Computer Science, State University."
                )
                cur.execute(
                    """
                    INSERT INTO parsed_resumes (
                        id, "resumeId", "rawText", "candidateName", "pageCount",
                        "atsScore", "createdAt", "updatedAt"
                    ) VALUES (
                        gen_random_uuid(), %s, %s, 'Jane Doe', 1, 95.0, NOW(), NOW()
                    );
                    """,
                    (resume_id, raw_text),
                )
        conn.commit()

    return user_id, resume_id


def _cleanup_test_data(user_id: str) -> None:
    """Cleans up the test user and cascades to resume, chunks, and parsed data."""
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM users WHERE id = %s;", (user_id,))
        conn.commit()


@pytest.mark.asyncio
async def test_embedding_worker_lifecycle_and_persistence():
    """Verifies that an EMBED_DOCUMENT job parses text, embeds, and persists chunks."""
    user_id, resume_id = _create_test_user_and_resume(status="PARSED")
    try:
        job = Job.__new__(Job)
        job.id = f"embed-{resume_id}"
        job.data = {"type": "EMBED_DOCUMENT", "resumeId": resume_id}

        result = await process_embed_document(job)

        assert result["status"] == "EMBEDDED"
        assert result["resumeId"] == resume_id
        assert result["chunkCount"] > 0
        assert result["embeddingDimension"] == 384

        # Verify chunks in database
        with psycopg.connect(settings.database_url) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT "chunkIndex", "sectionType", content, embedding, "tokenCount"
                    FROM resume_chunks
                    WHERE "resumeId" = %s
                    ORDER BY "chunkIndex" ASC;
                    """,
                    (resume_id,),
                )
                rows = cur.fetchall()
                assert len(rows) == result["chunkCount"]

                for row in rows:
                    chunk_idx, sec_type, content, emb, token_count = row
                    assert sec_type in {"SUMMARY", "SKILLS", "EXPERIENCE", "EDUCATION", "OTHER"}
                    assert len(content) > 0
                    assert len(emb) == 384
                    assert token_count > 0

                # Verify metadata updated in parsed_resumes
                cur.execute(
                    'SELECT "parsingMetadata" FROM parsed_resumes WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                meta_row = cur.fetchone()
                assert meta_row is not None
                meta = meta_row[0]
                assert "embeddedAt" in meta
                assert meta["chunkCount"] == result["chunkCount"]
                assert meta["embeddingDimension"] == 384
    finally:
        _cleanup_test_data(user_id)


@pytest.mark.asyncio
async def test_embedding_worker_idempotency_duplicate_delivery():
    """
    Verifies that running the same embedding job twice produces the exact same chunk count
    and does NOT create duplicate chunks or violate constraints.
    """
    user_id, resume_id = _create_test_user_and_resume(status="PARSED")
    try:
        job = Job.__new__(Job)
        job.id = f"embed-{resume_id}"
        job.data = {"type": "EMBED_DOCUMENT", "resumeId": resume_id}

        # Run 1
        res1 = await process_embed_document(job)
        assert res1["status"] == "EMBEDDED"

        # Count chunks after Run 1
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM resume_chunks WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                count_run1 = cur.fetchone()[0]

        # Run 2 (Simulated duplicate delivery or retry)
        res2 = await process_embed_document(job)
        assert res2["status"] == "EMBEDDED"

        # Count chunks after Run 2
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM resume_chunks WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                count_run2 = cur.fetchone()[0]

        assert count_run1 == count_run2
        assert count_run2 == res1["chunkCount"]

    finally:
        _cleanup_test_data(user_id)


@pytest.mark.asyncio
async def test_embedding_worker_aborts_on_unparsed_status():
    """Verifies that the embedding worker aborts if the resume is not in PARSED status."""
    user_id, resume_id = _create_test_user_and_resume(status="EXTRACTING")
    try:
        job = Job.__new__(Job)
        job.id = f"embed-{resume_id}"
        job.data = {"type": "EMBED_DOCUMENT", "resumeId": resume_id}

        result = await process_embed_document(job)
        assert result["status"] == "ABORTED"
        assert "INVALID_STATUS" in result["reason"]

        # Verify no chunks were persisted
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM resume_chunks WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                assert cur.fetchone()[0] == 0
    finally:
        _cleanup_test_data(user_id)


@pytest.mark.asyncio
async def test_embedding_worker_aborts_on_deleted_resume():
    """Verifies that the worker aborts cleanly if the resume was deleted."""
    non_existent_id = str(uuid.uuid4())
    job = Job.__new__(Job)
    job.id = f"embed-{non_existent_id}"
    job.data = {"type": "EMBED_DOCUMENT", "resumeId": non_existent_id}

    result = await process_embed_document(job)
    assert result["status"] == "ABORTED"
    assert result["reason"] == "RESUME_NOT_FOUND"


def test_persist_resume_chunks_transaction_rollback_on_error():
    """Verifies that DB failure during chunk insertion rolls back transaction completely."""
    user_id, resume_id = _create_test_user_and_resume(status="PARSED")
    try:
        # Create 1 valid chunk and 1 corrupt chunk (null content violates NOT NULL)
        valid_chunk = TextChunk(
            chunk_index=0,
            section_type="SUMMARY",
            heading="SUMMARY",
            content="Valid content",
            start_char=0,
            end_char=13,
            token_count=2,
            metadata={},
        )
        corrupt_chunk = TextChunk(
            chunk_index=1,
            section_type="EXPERIENCE",
            heading="EXPERIENCE",
            content=None,  # Will trigger NOT NULL constraint violation on content column
            start_char=14,
            end_char=20,
            token_count=2,
            metadata={},
        )

        dummy_vec = [0.0] * 384
        chunk_vectors = [(valid_chunk, dummy_vec), (corrupt_chunk, dummy_vec)]

        with pytest.raises(psycopg.Error):
            persist_resume_chunks(resume_id, chunk_vectors)

        # Confirm 0 chunks exist in database (atomic rollback)
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM resume_chunks WHERE "resumeId" = %s;', (resume_id,)
                )
                count = cur.fetchone()[0]
                assert count == 0, f"Expected 0 chunks after transaction rollback, found {count}"

    finally:
        _cleanup_test_data(user_id)


@pytest.mark.asyncio
async def test_embedding_worker_aborts_on_job_entity_phase3b_deferred():
    """Verifies that job embedding requests are cleanly deferred to Phase 3B without error."""
    job = Job.__new__(Job)
    job.id = "embed-job-123"
    job.data = {"type": "EMBED_DOCUMENT", "entityType": "JOB", "jobId": "job-123"}

    result = await process_embed_document(job)
    assert result["status"] == "ABORTED"
    assert result["reason"] == "JOB_EMBEDDING_DEFERRED_PHASE3B"


def test_record_embedding_error_preserves_existing_parsing_metadata():
    """Verifies that recording an embedding error merges into existing parsingMetadata without overwriting it."""
    user_id, resume_id = _create_test_user_and_resume(status="PARSED")
    try:
        # Prepopulate existing parsingMetadata (e.g. from parsing worker)
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE parsed_resumes
                    SET "parsingMetadata" = '{"extractor": "pdfplumber", "pageCount": 1, "customFlag": true}'::jsonb
                    WHERE "resumeId" = %s;
                    """,
                    (resume_id,),
                )
            conn.commit()

        # Record embedding error
        record_embedding_error(resume_id, "EMBED_TEST_ERR", "Simulated embedding failure")

        # Inspect resulting metadata
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT "parsingMetadata" FROM parsed_resumes WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                meta = cur.fetchone()[0]

        assert meta["extractor"] == "pdfplumber"
        assert meta["customFlag"] is True
        assert meta["embeddingErrorCode"] == "EMBED_TEST_ERR"
        assert meta["embeddingError"] == "Simulated embedding failure"
        assert "embeddingFailedAt" in meta

    finally:
        _cleanup_test_data(user_id)

