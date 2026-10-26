"""
Live end-to-end integration test against the real running Docker cluster.

Flow:
1. Backend issues presigned upload URL (/v1/resumes/upload-url).
2. Binary bytes (PDF / DOCX / Scanned PDF) are uploaded to MinIO.
3. Client notifies backend (/v1/resumes/:id/complete).
4. Backend enqueues PARSE_DOCUMENT job to BullMQ ('resume-parsing-queue').
5. resumatch-ml-worker picks up job, extracts text / OCR, saves parsed_resumes record.
6. Verify database state transitions and parsed entities directly in PostgreSQL.
"""

import hashlib
import io
import os
import time
import uuid
from typing import Any

import docx
import fitz
import httpx
import psycopg
import pytest
from PIL import Image, ImageDraw

from ml.config import settings

# Live marker: Never collected by default pytest runs, skipped unless RUN_LIVE_E2E=1
pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("RUN_LIVE_E2E") != "1",
        reason="Live E2E test skipped unless RUN_LIVE_E2E=1",
    ),
]

BACKEND_URL = os.getenv("BACKEND_URL", "http://backend:4000")
DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def make_authenticated_token() -> str:
    """Obtain a real session access token via session registration/login against the backend."""
    username = f"live_e2e_{uuid.uuid4().hex[:8]}"
    password = "LiveE2ePassword123!"

    with httpx.Client(timeout=10.0) as client:
        # Register a new user session directly via backend /v1/auth/register
        res = client.post(
            f"{BACKEND_URL}/v1/auth/register",
            json={"username": username, "password": password},
        )
        if res.status_code == 201:
            data = res.json()
            return str(data["tokens"]["accessToken"])

        login_res = client.post(
            f"{BACKEND_URL}/v1/auth/login",
            json={"username": username, "password": password},
        )
        if login_res.status_code == 200:
            data = login_res.json()
            return str(data["tokens"]["accessToken"])

        raise RuntimeError(f"Failed to authenticate live e2e session: {res.status_code} {res.text}")


def build_sample_pdf() -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    text = (
        "Jane Doe\n"
        "jane.doe@example.com | (555) 987-6543 | San Francisco, CA\n\n"
        "Summary\n"
        "Senior Cloud Architect with 8 years of experience building resilient systems.\n\n"
        "Experience\n"
        "Principal Engineer at CloudScale Inc (2020 - Present)\n"
        "- Designed high-throughput distributed systems in Python, Go, and PostgreSQL.\n"
        "- Led migration to Kubernetes on AWS.\n\n"
        "Education\n"
        "B.S. in Computer Science, UC Berkeley (2016)\n\n"
        "Skills\n"
        "Python, Go, Docker, Kubernetes, AWS, PostgreSQL, Redis, CI/CD"
    )
    page.insert_text(fitz.Point(72, 72), text, fontsize=11)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()
    return buf.getvalue()


def build_sample_docx() -> bytes:
    doc = docx.Document()
    doc.add_heading("Jane Doe", level=0)
    doc.add_paragraph("jane.doe@example.com | (555) 987-6543 | San Francisco, CA")
    doc.add_heading("Experience", level=1)
    doc.add_paragraph("Principal Engineer at CloudScale Inc (2020 - Present)")
    doc.add_paragraph("Architected scalable cloud platforms using Python and Docker.")
    doc.add_heading("Education", level=1)
    doc.add_paragraph("B.S. in Computer Science, UC Berkeley (2016)")
    doc.add_heading("Skills", level=1)
    doc.add_paragraph("Python, Docker, PostgreSQL, Kubernetes")
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def build_scanned_pdf() -> bytes:
    img = Image.new("RGB", (800, 1000), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    lines = [
        "JANE DOE",
        "jane.doe@example.com",
        "555-987-6543",
        "EXPERIENCE",
        "Senior Software Engineer at AlphaCorp",
        "Developed Python backend microservices and REST APIs.",
        "EDUCATION",
        "Bachelor of Science in Computer Science",
        "SKILLS",
        "Python, Docker, Linux, SQL, REST APIs",
    ]
    y = 60
    for line in lines:
        draw.text((60, y), line, fill=(0, 0, 0))
        y += 45

    img_buf = io.BytesIO()
    img.save(img_buf, format="PNG")
    img_bytes = img_buf.getvalue()

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, stream=img_bytes)
    pdf_buf = io.BytesIO()
    doc.save(pdf_buf)
    doc.close()
    return pdf_buf.getvalue()


def wait_for_status(
    resume_id: str,
    expected_status: str,
    timeout_sec: float = 30.0,
) -> dict[str, Any]:
    deadline = time.time() + timeout_sec
    last_status = None
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            while time.time() < deadline:
                cur.execute(
                    """
                    SELECT status, "extractionMethod", "errorCode", "errorMessage"
                    FROM resumes WHERE id = %s
                    """,
                    (resume_id,),
                )
                row = cur.fetchone()
                if row:
                    last_status, method, err_code, err_msg = row[0], row[1], row[2], row[3]
                    if last_status == expected_status or last_status == "FAILED":
                        return {
                            "status": last_status,
                            "extractionMethod": method,
                            "errorCode": err_code,
                            "errorMessage": err_msg,
                        }
                time.sleep(0.5)
    raise TimeoutError(
        f"Resume {resume_id} timed out waiting for {expected_status}, last={last_status}"
    )


@pytest.mark.asyncio
async def test_live_pdf_pipeline_e2e() -> None:
    token = make_authenticated_token()
    pdf_bytes = build_sample_pdf()
    sha256_hash = hashlib.sha256(pdf_bytes).hexdigest()

    async with httpx.AsyncClient() as client:
        # 1. Request presigned upload URL from backend
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        init_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/upload-url",
            json={
                "filename": "live_test_resume.pdf",
                "sizeBytes": len(pdf_bytes),
                "mimeType": "application/pdf",
            },
            headers=headers,
            timeout=10.0,
        )
        assert init_res.status_code == 200, f"Init upload failed: {init_res.text}"
        data = init_res.json()
        resume_id = data["resumeId"]
        upload_url = data["uploadUrl"]

        # In docker network, swap localhost:9000 with minio:9000
        upload_url_docker = upload_url.replace("localhost:9000", "minio:9000")
        upload_url_docker = upload_url_docker.replace("127.0.0.1:9000", "minio:9000")

        # 2. Upload file to MinIO (provide signed Host header)
        put_res = await client.put(
            upload_url_docker,
            content=pdf_bytes,
            headers={"Content-Type": "application/pdf", "Host": "localhost:9000"},
            timeout=10.0,
        )
        assert put_res.status_code == 200, f"MinIO PUT failed: {put_res.status_code}"

        # 3. Notify backend upload completed
        complete_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/{resume_id}/complete",
            json={"sha256": sha256_hash},
            headers=headers,
            timeout=10.0,
        )
        assert complete_res.status_code == 202, f"Complete call failed: {complete_res.text}"

    # 4. Wait for resumatch-ml-worker to process BullMQ job
    result = wait_for_status(resume_id, "PARSED", timeout_sec=25.0)
    assert result["status"] == "PARSED", f"Expected PARSED, got {result}"
    assert result["extractionMethod"] == "TEXT_LAYER"

    # 5. Verify parsed_resumes database table
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT "pageCount", "rawText", "atsScore", "candidateName", "contactInfo", "skills"
                FROM parsed_resumes WHERE "resumeId" = %s
                """,
                (resume_id,),
            )
            row = cur.fetchone()
            assert row is not None, "parsed_resumes record not found in PostgreSQL"
            page_count, raw_text, ats_score, candidate_name, contact_info, skills = (
                row[0],
                row[1],
                row[2],
                row[3],
                row[4],
                row[5],
            )
            assert page_count >= 1
            assert "Jane Doe" in raw_text
            assert 0.0 <= ats_score <= 100.0
            assert candidate_name == "Jane Doe"
            assert "jane.doe@example.com" in contact_info.get("email", "")
            skill_names = [s.get("name") for s in skills]
            assert "Python" in skill_names


@pytest.mark.asyncio
async def test_live_docx_pipeline_e2e() -> None:
    token = make_authenticated_token()
    docx_bytes = build_sample_docx()
    sha256_hash = hashlib.sha256(docx_bytes).hexdigest()

    async with httpx.AsyncClient() as client:
        # 1. Request presigned upload URL
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        init_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/upload-url",
            json={
                "filename": "live_test_resume.docx",
                "sizeBytes": len(docx_bytes),
                "mimeType": DOCX_MIME,
            },
            headers=headers,
            timeout=10.0,
        )
        assert init_res.status_code == 200, f"Init upload failed: {init_res.text}"
        data = init_res.json()
        resume_id = data["resumeId"]
        upload_url = data["uploadUrl"]

        upload_url_docker = upload_url.replace("localhost:9000", "minio:9000")
        upload_url_docker = upload_url_docker.replace("127.0.0.1:9000", "minio:9000")

        # 2. Upload DOCX to MinIO
        put_res = await client.put(
            upload_url_docker,
            content=docx_bytes,
            headers={"Content-Type": DOCX_MIME, "Host": "localhost:9000"},
            timeout=10.0,
        )
        assert put_res.status_code == 200, f"MinIO PUT failed: {put_res.status_code}"

        # 3. Notify backend
        complete_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/{resume_id}/complete",
            json={"sha256": sha256_hash},
            headers=headers,
            timeout=10.0,
        )
        assert complete_res.status_code == 202

    # 4. Wait for worker
    result = wait_for_status(resume_id, "PARSED", timeout_sec=35.0)
    assert result["status"] == "PARSED", f"Expected PARSED, got {result}"
    assert result["extractionMethod"] == "DOCX"

    # 5. Check parsed_resumes record
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT "pageCount", "rawText", "candidateName", "skills"
                FROM parsed_resumes WHERE "resumeId" = %s
                """,
                (resume_id,),
            )
            row = cur.fetchone()
            assert row is not None
            page_count, raw_text, candidate_name, skills = row[0], row[1], row[2], row[3]
            assert page_count >= 1
            assert "Jane Doe" in raw_text
            assert candidate_name == "Jane Doe"
            skill_names = [s.get("name") for s in skills]
            assert "Python" in skill_names


@pytest.mark.asyncio
async def test_live_scanned_pdf_ocr_pipeline_e2e() -> None:
    token = make_authenticated_token()
    scanned_bytes = build_scanned_pdf()
    sha256_hash = hashlib.sha256(scanned_bytes).hexdigest()

    async with httpx.AsyncClient() as client:
        # 1. Request upload URL
        headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        init_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/upload-url",
            json={
                "filename": "scanned_resume.pdf",
                "sizeBytes": len(scanned_bytes),
                "mimeType": "application/pdf",
            },
            headers=headers,
            timeout=10.0,
        )
        assert init_res.status_code == 200, f"Init upload failed: {init_res.text}"
        data = init_res.json()
        resume_id = data["resumeId"]
        upload_url = data["uploadUrl"]

        upload_url_docker = upload_url.replace("localhost:9000", "minio:9000")
        upload_url_docker = upload_url_docker.replace("127.0.0.1:9000", "minio:9000")

        # 2. Upload to MinIO
        put_res = await client.put(
            upload_url_docker,
            content=scanned_bytes,
            headers={"Content-Type": "application/pdf", "Host": "localhost:9000"},
            timeout=10.0,
        )
        assert put_res.status_code == 200, f"MinIO PUT failed: {put_res.status_code}"

        # 3. Complete
        complete_res = await client.post(
            f"{BACKEND_URL}/v1/resumes/{resume_id}/complete",
            json={"sha256": sha256_hash},
            headers=headers,
            timeout=10.0,
        )
        assert complete_res.status_code == 202

    # 4. Wait for OCR processing and completion
    result = wait_for_status(resume_id, "PARSED", timeout_sec=60.0)
    assert result["status"] == "PARSED", f"Expected PARSED, got {result}"
    assert result["extractionMethod"] == "OCR"

    # 5. Check parsed_resumes record
    with psycopg.connect(settings.database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT "pageCount", "rawText", "atsScore"
                FROM parsed_resumes WHERE "resumeId" = %s
                """,
                (resume_id,),
            )
            row = cur.fetchone()
            assert row is not None
            page_count, raw_text, ats_score = row[0], row[1], row[2]
            assert page_count >= 1
            assert len(raw_text) > 50
            assert 0.0 <= ats_score <= 100.0
