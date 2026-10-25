import os
import tempfile
import uuid
from typing import Any

import psycopg
import pytest

from ml.config import settings
from ml.pipelines.intake.parser import parse_document
from ml.pipelines.intake.repository import (
    mark_resume_failed,
    save_parsed_resume,
    update_resume_status,
)
from ml.storage.s3 import get_s3_client
from ml.tests.test_parser import create_sample_pdf
from ml.worker import process_parse_document


def get_or_create_test_user() -> str:
    """Ensures a test user exists in DB and returns user ID."""
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM users LIMIT 1;")
            row = cur.fetchone()
            if row:
                return str(row[0])
            user_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO users (id, email, role, "createdAt", "updatedAt")
                VALUES (%s, 'test_worker@example.com', 'CANDIDATE', NOW(), NOW());
                """,
                (user_id,),
            )
            conn.commit()
            return user_id


def create_test_resume(user_id: str, filename: str, mime_type: str, storage_key: str) -> str:
    """Creates a Resume record in UPLOADED status."""
    resume_id = str(uuid.uuid4())
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO resumes (
                    id, "userId", "originalFilename", "storageKey", "mimeType",
                    "sizeBytes", status, "createdAt", "updatedAt"
                ) VALUES (%s, %s, %s, %s, %s, 1024, 'UPLOADED'::"ResumeStatus", NOW(), NOW());
                """,
                (resume_id, user_id, filename, storage_key, mime_type),
            )
            conn.commit()
    return resume_id


def cleanup_test_resume(resume_id: str) -> None:
    """Deletes test resume and cascades."""
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM resumes WHERE id = %s;", (resume_id,))
            conn.commit()


def test_status_transitions_and_persistence() -> None:
    user_id = get_or_create_test_user()
    resume_id = create_test_resume(
        user_id, "test_resume.pdf", "application/pdf", f"resumes/{user_id}/test.pdf"
    )

    try:
        # 1. Transition to EXTRACTING
        update_resume_status(resume_id, "EXTRACTING")
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT status FROM resumes WHERE id = %s;", (resume_id,))
                row_status = cur.fetchone()
                assert row_status is not None
                status = row_status[0]
                assert status == "EXTRACTING"

        # 2. Parse a valid sample document
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
            create_sample_pdf(tf.name)
            parse_result = parse_document(tf.name, "application/pdf")
            os.remove(tf.name)

        # 3. Save parsed resume
        save_parsed_resume(resume_id, parse_result)

        # 4. Verify DB state in resumes and parsed_resumes
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT status, "extractionMethod", "errorCode"
                    FROM resumes WHERE id = %s;
                    """,
                    (resume_id,),
                )
                row_res = cur.fetchone()
                assert row_res is not None
                r_status, r_method, r_err = row_res
                assert r_status == "PARSED"
                assert r_method == "TEXT_LAYER"
                assert r_err is None

                cur.execute(
                    """
                    SELECT "rawText", "atsScore", "pageCount", skills, experience
                    FROM parsed_resumes WHERE "resumeId" = %s;
                    """,
                    (resume_id,),
                )
                row_parsed = cur.fetchone()
                assert row_parsed is not None
                raw_text, ats_score, page_count, skills, experience = row_parsed
                assert "Jane Doe" in raw_text
                assert ats_score >= 80.0
                assert page_count == 1
                assert len(skills) > 0

        # 5. Idempotent re-save: verify duplicate call updates row without duplicate key error
        save_parsed_resume(resume_id, parse_result)
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM parsed_resumes WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                row_cnt = cur.fetchone()
                assert row_cnt is not None
                count = row_cnt[0]
                assert count == 1

    finally:
        cleanup_test_resume(resume_id)


def test_mark_resume_failed_state() -> None:
    user_id = get_or_create_test_user()
    resume_id = create_test_resume(
        user_id, "corrupt.pdf", "application/pdf", f"resumes/{user_id}/corrupt.pdf"
    )

    try:
        mark_resume_failed(resume_id, "CORRUPT_FILE", "The file is corrupt.")

        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT status, "errorCode", "errorMessage" FROM resumes WHERE id = %s;',
                    (resume_id,),
                )
                row_failed = cur.fetchone()
                assert row_failed is not None
                status, err_code, err_msg = row_failed
                assert status == "FAILED"
                assert err_code == "CORRUPT_FILE"
                assert err_msg == "The file is corrupt."
    finally:
        cleanup_test_resume(resume_id)


class DummyJob:
    def __init__(self, data: dict[str, Any], job_id: str = "test-job-id") -> None:
        self.data = data
        self.id = job_id


@pytest.mark.asyncio
async def test_worker_missing_storage_object() -> None:
    from ml.worker import process_parse_document

    user_id = get_or_create_test_user()
    storage_key = f"resumes/{user_id}/non_existent_key_{uuid.uuid4()}.pdf"
    resume_id = create_test_resume(
        user_id, "missing.pdf", "application/pdf", storage_key
    )

    try:
        job = DummyJob({
            "type": "PARSE_DOCUMENT",
            "resumeId": resume_id,
            "bucket": settings.s3_bucket,
            "storageKey": storage_key,
            "mimeType": "application/pdf",
        })
        result = await process_parse_document(job)
        assert result["status"] == "FAILED"
        assert result["errorCode"] == "STORAGE_OBJECT_NOT_FOUND"

        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT status, "errorCode" FROM resumes WHERE id = %s;',
                    (resume_id,),
                )
                row_missing = cur.fetchone()
                assert row_missing is not None
                status, err_code = row_missing
                assert status == "FAILED"
                assert err_code == "STORAGE_OBJECT_NOT_FOUND"
    finally:
        cleanup_test_resume(resume_id)


@pytest.mark.asyncio
async def test_worker_corrupt_file_handling() -> None:
    from ml.storage.s3 import get_s3_client
    from ml.worker import process_parse_document

    user_id = get_or_create_test_user()
    storage_key = f"resumes/{user_id}/corrupt_test_{uuid.uuid4()}.pdf"
    resume_id = create_test_resume(
        user_id, "corrupt_test.pdf", "application/pdf", storage_key
    )

    # Put corrupt bytes into MinIO
    s3 = get_s3_client()
    s3.put_object(
        Bucket=settings.s3_bucket,
        Key=storage_key,
        Body=b"%PDF-corrupt garbage bytes that fail parser",
    )

    try:
        job = DummyJob({
            "type": "PARSE_DOCUMENT",
            "resumeId": resume_id,
            "bucket": settings.s3_bucket,
            "storageKey": storage_key,
            "mimeType": "application/pdf",
        })
        result = await process_parse_document(job)
        assert result["status"] == "FAILED"
        assert result["errorCode"] == "CORRUPT_FILE"

        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT status, "errorCode" FROM resumes WHERE id = %s;',
                    (resume_id,),
                )
                row_corrupt = cur.fetchone()
                assert row_corrupt is not None
                status, err_code = row_corrupt
                assert status == "FAILED"
                assert err_code == "CORRUPT_FILE"
    finally:
        s3.delete_object(Bucket=settings.s3_bucket, Key=storage_key)
        cleanup_test_resume(resume_id)


@pytest.mark.asyncio
async def test_worker_duplicate_job_idempotency() -> None:
    from ml.storage.s3 import get_s3_client
    from ml.worker import process_parse_document

    user_id = get_or_create_test_user()
    storage_key = f"resumes/{user_id}/idempotent_{uuid.uuid4()}.pdf"
    resume_id = create_test_resume(
        user_id, "idempotent.pdf", "application/pdf", storage_key
    )

    # Generate valid PDF and upload to S3
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        create_sample_pdf(tf.name)
        with open(tf.name, "rb") as f:
            pdf_bytes = f.read()
        os.remove(tf.name)

    s3 = get_s3_client()
    s3.put_object(
        Bucket=settings.s3_bucket,
        Key=storage_key,
        Body=pdf_bytes,
    )

    try:
        job = DummyJob({
            "type": "PARSE_DOCUMENT",
            "resumeId": resume_id,
            "bucket": settings.s3_bucket,
            "storageKey": storage_key,
            "mimeType": "application/pdf",
        })

        # 1. First execution
        result_1 = await process_parse_document(job)
        assert result_1["status"] == "PARSED"
        assert result_1["extractionMethod"] == "TEXT_LAYER"

        # 2. Duplicate execution (simulating BullMQ retry / duplicate redelivery)
        result_2 = await process_parse_document(job)
        assert result_2["status"] == "PARSED"
        assert result_2["extractionMethod"] == "TEXT_LAYER"

        # 3. Assert exactly one ParsedResume record exists
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM parsed_resumes WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                row_idem = cur.fetchone()
                assert row_idem is not None
                count = row_idem[0]
                assert count == 1
    finally:
        s3.delete_object(Bucket=settings.s3_bucket, Key=storage_key)
        cleanup_test_resume(resume_id)


@pytest.mark.asyncio
async def test_worker_handles_resume_deleted_while_queued() -> None:
    """
    Verifies that if a resume is deleted while a job is queued/in-flight,
    the worker aborts without resurrecting.
    """
    user_id = get_or_create_test_user()
    resume_id = str(uuid.uuid4())
    storage_key = f"resumes/{user_id}/{resume_id}.pdf"

    # Create Resume in DB
    create_test_resume(user_id, "deleted_race.pdf", "application/pdf", storage_key)

    # Put object in S3
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tf:
        create_sample_pdf(tf.name)
        with open(tf.name, "rb") as f:
            pdf_bytes = f.read()
        os.remove(tf.name)

    s3 = get_s3_client()
    s3.put_object(Bucket=settings.s3_bucket, Key=storage_key, Body=pdf_bytes)

    # Delete resume from database before worker processes it (simulating DELETE endpoint)
    cleanup_test_resume(resume_id)

    try:
        job = DummyJob({
            "type": "PARSE_DOCUMENT",
            "resumeId": resume_id,
            "bucket": settings.s3_bucket,
            "storageKey": storage_key,
            "mimeType": "application/pdf",
        })

        # Process job — worker should detect deletion and abort gracefully
        result = await process_parse_document(job)
        assert result["status"] == "ABORTED"
        assert result["reason"] == "RESUME_DELETED"

        # Ensure no records exist in parsed_resumes
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    'SELECT COUNT(*) FROM parsed_resumes WHERE "resumeId" = %s;',
                    (resume_id,),
                )
                row_del = cur.fetchone()
                assert row_del is not None
                count = row_del[0]
                assert count == 0
    finally:
        s3.delete_object(Bucket=settings.s3_bucket, Key=storage_key)
