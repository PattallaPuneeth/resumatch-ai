import asyncio
import json
import logging
import os
import signal
import socket
import threading
import time
from datetime import UTC, datetime
from types import FrameType
from typing import Any, Literal

import psycopg
import redis.asyncio as aioredis
from bullmq import Job, Queue, Worker

from ml.config import settings
from ml.eval.metrics import (
    DEFAULT_STRONG_THRESHOLD,
    DEFAULT_WEAK_THRESHOLD,
)
from ml.pipelines.embeddings.chunker import chunk_job_text, chunk_resume_text
from ml.pipelines.embeddings.embedder import generate_chunk_embeddings, get_embedder
from ml.pipelines.embeddings.repository import (
    get_job_data,
    get_parsed_resume_data,
    persist_job_chunks,
    persist_resume_chunks,
    record_embedding_error,
)
from ml.pipelines.intake.exceptions import (
    CorruptFileError,
    EncryptedPdfError,
    OcrDeferredError,
    StorageObjectNotFoundError,
    TextTooShortAfterOcrError,
    TooManyPagesError,
    UnsupportedTypeError,
)
from ml.pipelines.intake.parser import parse_document
from ml.pipelines.intake.repository import (
    get_resume_status,
    mark_resume_failed,
    save_parsed_resume,
    update_resume_status,
)
from ml.pipelines.llm.config import PROMPT_VERSION, llm_settings
from ml.pipelines.llm.gateway import LLMUnavailableError, llm_gateway
from ml.pipelines.llm.models import StructuredAnalysisResult
from ml.pipelines.llm.repository import (
    get_analysis_context,
    persist_analysis_result,
)
from ml.pipelines.llm.safety import (
    detect_prompt_injection,
    redact_pii,
)
from ml.pipelines.matching.lexical import search_lexical
from ml.pipelines.matching.repository import (
    MatchTargetGoneError,
    ResumeNotEmbeddedError,
    count_embedded_resume_chunks,
    get_match_context,
    persist_match_result,
)
from ml.pipelines.matching.reranker import (
    build_bounded_rerank_query,
    get_cross_encoder,
    rerank_candidates,
)
from ml.pipelines.matching.rrf import aggregate_resume_rrf, fuse_ranks
from ml.pipelines.matching.scorer import compute_match_scores
from ml.pipelines.matching.semantic import search_semantic
from ml.pipelines.matching.seniority import seniority_fit
from ml.pipelines.matching.skill_gap import (
    analyze_skill_gap,
    extract_alternative_groups,
    resolve_required_skills,
    resolve_skill_requirements,
)
from ml.storage.s3 import download_file
from ml.utils.logging_setup import configure_logging
from ml.utils.telemetry import init_telemetry, queue_carrier, record_match_metrics, stage_span

# How long a match waits for the resume's embedding job (see _process_match_scoring)
EMBEDDING_WAIT_SECONDS = 30.0
EMBEDDING_POLL_SECONDS = 0.5

configure_logging("resumatch-ml-worker", level="info")
logger = logging.getLogger("resumatch-ml-worker")

# All four BullMQ workers share this process's event loop. Blocking work (S3 I/O, parsing/OCR,
# model inference, synchronous DB calls) runs via asyncio.to_thread so the loop keeps serving
# every worker's Redis waits and lock renewals. Blocking it stalled job pickup for tens of
# seconds (docs/PERFORMANCE.md, Finding 1).
#
# Parsing is serialized: PyMuPDF does not support concurrent use from several threads, and two
# OCR jobs at once hung for 5 to 13 minutes in load tests instead of ~7 s.
_PARSE_LOCK = threading.Lock()


def _parse_document_serialized(*args: Any, **kwargs: Any) -> Any:
    with _PARSE_LOCK:
        return parse_document(*args, **kwargs)


_parse_worker: Worker | None = None
_embed_worker: Worker | None = None
_match_worker: Worker | None = None
_analysis_worker: Worker | None = None
_ocr_worker: Worker | None = None
_embedding_queue: Queue | None = None
_ocr_queue: Queue | None = None
_should_exit = False

OCR_QUEUE_NAME = "resume-ocr-queue"
ALL_QUEUES = ("parse", "ocr", "embed", "match", "analysis")


def served_queues(spec: str, ocr_queue_enabled: bool = False) -> set[str]:
    """
    Parses WORKER_QUEUES ("all" or a comma list) into the set of queue roles to serve. With a
    dedicated OCR worker (OCR_QUEUE_ENABLED), "all" leaves the OCR queue to that worker.
    """
    if spec.strip().lower() in ("", "all"):
        return set(ALL_QUEUES) - ({"ocr"} if ocr_queue_enabled else set())
    roles = {r.strip().lower() for r in spec.split(",") if r.strip()}
    unknown = roles - set(ALL_QUEUES)
    if unknown:
        raise ValueError(f"Unknown WORKER_QUEUES roles: {sorted(unknown)}")
    return roles


def get_ocr_queue() -> Queue:
    """Returns singleton Queue producer for resume-ocr-queue."""
    global _ocr_queue
    if _ocr_queue is None:
        _ocr_queue = Queue(OCR_QUEUE_NAME, {"connection": settings.redis_url, "prefix": "bull"})
    return _ocr_queue


async def enqueue_ocr_job(job_data: dict[str, Any], resume_id: str) -> None:
    """Hands a scanned PDF to the OCR worker, keeping the backend's trace context."""
    await get_ocr_queue().add(
        "OCR_DOCUMENT",
        dict(job_data),
        {
            "jobId": f"ocr-{resume_id}",
            "attempts": 3,
            "backoff": {"type": "exponential", "delay": 2000},
            "removeOnComplete": 100,
            "removeOnFail": 500,
        },
    )
    logger.info("Deferred OCR for resume %s to %s", resume_id, OCR_QUEUE_NAME)


def get_embedding_queue() -> Queue:
    """Returns singleton Queue producer for embedding-queue."""
    global _embedding_queue
    if _embedding_queue is None:
        _embedding_queue = Queue(
            "embedding-queue",
            {"connection": settings.redis_url, "prefix": "bull"},
        )
    return _embedding_queue


def get_user_id_for_resume(resume_id: str) -> str | None:
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT "userId" FROM resumes WHERE id = %s;', (resume_id,))
                row = cur.fetchone()
                return str(row[0]) if row and row[0] else None
    except Exception:
        return None


def get_user_id_for_job(job_id: str) -> str | None:
    try:
        with psycopg.connect(settings.database_url) as conn:
            with conn.cursor() as cur:
                cur.execute('SELECT "userId" FROM jobs WHERE id = %s;', (job_id,))
                row = cur.fetchone()
                return str(row[0]) if row and row[0] else None
    except Exception:
        return None


_redis_pub_client: aioredis.Redis | None = None


def get_redis_pub_client() -> aioredis.Redis:
    global _redis_pub_client
    if _redis_pub_client is None:
        _redis_pub_client = aioredis.from_url(settings.redis_url)
    return _redis_pub_client


async def publish_user_event(user_id: str | None, event_type: str, data: dict[str, Any]) -> None:
    """Publishes a real-time event to the user's private channel over Redis Pub/Sub."""
    if not user_id:
        return
    try:
        r = get_redis_pub_client()
        channel = f"resumatch:events:user:{user_id}"
        payload = json.dumps({
            "type": event_type,
            "timestamp": datetime.now(UTC).isoformat(),
            "data": data,
        })
        await r.publish(channel, payload)
    except Exception as e:
        logger.debug("Failed to publish event %s for user %s: %s", event_type, user_id, e)


async def enqueue_embed_job(resume_id: str) -> None:
    """Enqueues an EMBED_DOCUMENT job for a parsed resume."""
    try:
        q = get_embedding_queue()
        await q.add(
            "EMBED_DOCUMENT",
            {
                "type": "EMBED_DOCUMENT",
                "entityType": "RESUME",
                "entityId": resume_id,
                "resumeId": resume_id,
            },
            {
                "jobId": f"embed-{resume_id}",
                "attempts": 3,
                "backoff": {"type": "exponential", "delay": 1000},
                "removeOnComplete": 100,
                "removeOnFail": 500,
            },
        )
        logger.info(
            "Enqueued EMBED_DOCUMENT job for resume %s (jobId=embed-%s)", resume_id, resume_id
        )
    except Exception as q_err:
        logger.exception("Failed to enqueue EMBED_DOCUMENT job for resume %s: %s", resume_id, q_err)


async def process_parse_document(job: Job, token: str | None = None) -> dict[str, Any]:
    """Traced entry point; the span joins the backend request that enqueued the job."""
    with stage_span("job", carrier=queue_carrier(job.data), queue="resume-parsing-queue"):
        return await _process_parse_document(job, token, allow_ocr=not settings.ocr_queue_enabled)


async def process_ocr_document(job: Job, token: str | None = None) -> dict[str, Any]:
    """Traced entry point for scanned PDFs deferred from resume-parsing-queue."""
    with stage_span("job", carrier=queue_carrier(job.data), queue=OCR_QUEUE_NAME):
        return await _process_parse_document(job, token, allow_ocr=True)


async def _process_parse_document(
    job: Job, token: str | None = None, allow_ocr: bool = True
) -> dict[str, Any]:
    """
    Processes a PARSE_DOCUMENT job from resume-parsing-queue, or its OCR continuation from
    resume-ocr-queue. With allow_ocr=False a PDF that needs OCR is handed to the OCR queue.
    """
    data = job.data
    resume_id = data.get("resumeId")
    storage_key = data.get("storageKey") or data.get("s3Key")
    bucket = data.get("bucket", settings.s3_bucket)
    mime_type = data.get("mimeType", "application/pdf")
    user_id = data.get("userId") or await asyncio.to_thread(get_user_id_for_resume, resume_id)

    if not resume_id or not storage_key:
        logger.error("Job %s missing resumeId or storageKey", job.id)
        raise ValueError("Invalid job payload: missing resumeId or storageKey")

    logger.info("Processing resume parsing job %s for resume %s", job.id, resume_id)

    # 1. Idempotency & existence check
    curr_status, curr_method = get_resume_status(resume_id)
    if curr_status is None:
        logger.info(
            "Resume %s was deleted prior to processing. Aborting job %s.", resume_id, job.id
        )
        return {"status": "ABORTED", "reason": "RESUME_DELETED"}
    if curr_status == "PARSED":
        logger.info(
            "Resume %s is already PARSED. Acknowledging duplicate job %s idempotently.",
            resume_id,
            job.id,
        )
        return {"status": "PARSED", "extractionMethod": curr_method or "TEXT_LAYER"}

    # Update status to EXTRACTING (an OCR continuation is already past it)
    if curr_status not in ("NEEDS_OCR", "OCR_PROCESSING") and not update_resume_status(
        resume_id, "EXTRACTING"
    ):
        logger.info(
            "Resume %s could not transition to EXTRACTING (current=%s). Aborting job %s.",
            resume_id,
            curr_status,
            job.id,
        )
        return {"status": "ABORTED", "reason": "INVALID_TRANSITION"}

    await publish_user_event(
        user_id, "RESUME_STATUS", {"resumeId": resume_id, "status": "EXTRACTING"}
    )

    # Determine local temp path
    ext = storage_key.split(".")[-1].lower() if "." in storage_key else "pdf"
    temp_dir = "/tmp" if os.path.exists("/tmp") else os.path.abspath("./tmp")
    os.makedirs(temp_dir, exist_ok=True)
    temp_file = os.path.join(temp_dir, f"resume_{resume_id}.{ext}")

    try:
        # 2. Download from S3 storage
        try:
            await asyncio.to_thread(download_file, storage_key, temp_file, bucket=bucket)
        except Exception as dl_err:
            logger.error("Failed to download storage object for resume %s: %s", resume_id, dl_err)
            raise StorageObjectNotFoundError(
                f"Failed to download {storage_key} from {bucket}"
            ) from dl_err

        # 3. Status callback for OCR routing
        def on_status_change(status: str) -> None:
            logger.info("Resume %s status transitioning to %s", resume_id, status)
            update_resume_status(resume_id, status)

        # 4. Parse document
        try:
            result = await asyncio.to_thread(
                _parse_document_serialized,
                temp_file,
                mime_type,
                status_callback=on_status_change,
                allow_ocr=allow_ocr,
            )
        except OcrDeferredError:
            await enqueue_ocr_job(data, resume_id)
            return {"status": "NEEDS_OCR", "resumeId": resume_id, "deferredTo": OCR_QUEUE_NAME}

        # 5. Persist results and transition to PARSED
        persisted = await asyncio.to_thread(save_parsed_resume, resume_id, result)
        if not persisted:
            logger.info(
                "Resume %s was deleted during processing. Aborting job %s.", resume_id, job.id
            )
            return {"status": "ABORTED", "reason": "RESUME_DELETED"}

        logger.info(
            "Resume %s successfully parsed and persisted (method=%s, score=%.1f)",
            resume_id,
            result.extraction_method,
            result.ats_score,
        )

        # 6. Enqueue embedding generation for the parsed resume
        await enqueue_embed_job(resume_id)
        await publish_user_event(
            user_id,
            "RESUME_STATUS",
            {
                "resumeId": resume_id,
                "status": "PARSED",
                "atsScore": result.ats_score,
                "method": result.extraction_method,
            },
        )

        return {
            "status": "PARSED",
            "resumeId": resume_id,
            "extractionMethod": result.extraction_method,
            "atsScore": result.ats_score,
            "pageCount": result.page_count,
        }

    except (
        CorruptFileError,
        EncryptedPdfError,
        TooManyPagesError,
        TextTooShortAfterOcrError,
        UnsupportedTypeError,
        StorageObjectNotFoundError,
    ) as e:
        logger.warning(
            "Permanent document failure for resume %s: code=%s, err=%s",
            resume_id,
            e.error_code,
            e,
        )
        mark_resume_failed(resume_id, e.error_code, e.safe_message)
        await publish_user_event(
            user_id,
            "RESUME_STATUS",
            {
                "resumeId": resume_id,
                "status": "FAILED",
                "errorCode": e.error_code,
                "errorMessage": e.safe_message,
            },
        )
        return {
            "status": "FAILED",
            "resumeId": resume_id,
            "errorCode": e.error_code,
            "errorMessage": e.safe_message,
        }
    except Exception as e:
        logger.exception("Unexpected error processing resume %s: %s", resume_id, e)
        # Transient / infrastructure error: let BullMQ retry with configured exponential backoff
        raise e
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception:
                pass


async def process_embed_document(job: Job, token: str | None = None) -> dict[str, Any]:
    """Traced entry point; the span joins the backend request that enqueued the job."""
    with stage_span("job", carrier=queue_carrier(job.data), queue="embedding-queue"):
        return await _process_embed_document(job, token)


async def _process_embed_document(job: Job, token: str | None = None) -> dict[str, Any]:
    """Processes an EMBED_DOCUMENT job from embedding-queue."""
    data = job.data
    entity_type = data.get("entityType", "RESUME")

    if entity_type == "JOB":
        job_id = data.get("jobId") or data.get("entityId")
        if not job_id:
            logger.error("Job embedding missing jobId or entityId in job %s", job.id)
            raise ValueError("Invalid job embedding payload: missing jobId or entityId")

        logger.info("Processing embedding job %s for Job %s", job.id, job_id)
        job_data = get_job_data(job_id)
        if not job_data:
            logger.info("Job %s not found (deleted). Aborting job %s.", job_id, job.id)
            return {"status": "ABORTED", "reason": "JOB_NOT_FOUND"}

        raw_desc = job_data.get("rawDescription", "")
        if not raw_desc or not raw_desc.strip():
            logger.warning("Job %s has empty rawDescription. Aborting.", job_id)
            return {"status": "ABORTED", "reason": "JOB_DESCRIPTION_EMPTY"}

        chunks = chunk_job_text(raw_desc)
        logger.info("Generated %d chunks for Job %s", len(chunks), job_id)
        chunk_vectors = await asyncio.to_thread(generate_chunk_embeddings, chunks)
        saved_count = await asyncio.to_thread(persist_job_chunks, job_id, chunk_vectors)

        return {
            "status": "EMBEDDED",
            "entityType": "JOB",
            "jobId": job_id,
            "chunkCount": saved_count,
            "embeddingDimension": 384,
        }

    resume_id = data.get("resumeId") or data.get("entityId")

    if not resume_id:
        logger.error("Job %s missing resumeId or entityId", job.id)
        raise ValueError("Invalid embedding job payload: missing resumeId or entityId")

    logger.info("Processing embedding job %s for resume %s", job.id, resume_id)

    # 1. Fetch parsed resume data
    parsed_data = get_parsed_resume_data(resume_id)
    if not parsed_data:
        logger.info(
            "Resume %s not found (deleted). Aborting job %s.",
            resume_id,
            job.id,
        )
        return {"status": "ABORTED", "reason": "RESUME_NOT_FOUND"}

    status = parsed_data["status"]
    if status != "PARSED":
        logger.warning(
            "Resume %s status is %s (expected PARSED). Aborting job %s.",
            resume_id,
            status,
            job.id,
        )
        return {"status": "ABORTED", "reason": f"INVALID_STATUS_{status}"}

    raw_text = parsed_data["rawText"]
    if not raw_text:
        logger.warning("Resume %s has no rawText. Aborting job %s.", resume_id, job.id)
        return {"status": "ABORTED", "reason": "PARSED_TEXT_NOT_FOUND"}

    try:
        # 2. Section-aware chunking with exact offsets
        chunks = chunk_resume_text(raw_text)
        logger.info("Generated %d chunks for resume %s", len(chunks), resume_id)

        # 3. Generate 384-dimensional vector embeddings
        chunk_vectors = await asyncio.to_thread(generate_chunk_embeddings, chunks)

        # 4. Atomically persist chunks to database
        saved_count = await asyncio.to_thread(persist_resume_chunks, resume_id, chunk_vectors)

        return {
            "status": "EMBEDDED",
            "resumeId": resume_id,
            "chunkCount": saved_count,
            "embeddingDimension": 384,
        }
    except Exception as e:
        logger.exception("Failed to process embedding for resume %s: %s", resume_id, e)
        record_embedding_error(resume_id, "EMBEDDING_FAILED", str(e))
        # Re-raise to trigger BullMQ retry
        raise e


async def process_match_scoring(job: Job, token: str | None = None) -> dict[str, Any]:
    """Traced entry point; the span joins the backend request that enqueued the job."""
    with stage_span("job", carrier=queue_carrier(job.data), queue="match-scoring-queue"):
        return await _process_match_scoring(job, token)


async def _process_match_scoring(job: Job, token: str | None = None) -> dict[str, Any]:
    """Processes a match calculation job from match-scoring-queue."""
    data = job.data
    job_id = data.get("jobId")
    resume_id = data.get("resumeId")
    user_id = data.get("userId") or await asyncio.to_thread(get_user_id_for_job, job_id)

    if not job_id or not resume_id:
        logger.error("Job %s missing jobId or resumeId in data: %s", job.id, data)
        raise ValueError("Invalid match scoring payload: missing jobId or resumeId")

    logger.info("Processing match scoring for resume %s and job %s", resume_id, job_id)

    ctx = get_match_context(resume_id, job_id)
    if not ctx:
        logger.info("Context not found for resume %s or job %s. Aborting.", resume_id, job_id)
        return {"status": "ABORTED", "reason": "CONTEXT_NOT_FOUND"}

    status = ctx.get("resume_status")
    if status != "PARSED":
        logger.warning("Resume %s status is %s (expected PARSED). Aborting.", resume_id, status)
        return {"status": "ABORTED", "reason": f"INVALID_STATUS_{status}"}

    job_title = ctx.get("job_title", "")
    job_desc = ctx.get("job_description", "")
    job_req_skills = ctx.get("job_required_skills")
    job_pref_skills = ctx.get("job_preferred_skills")
    resume_skills = ctx.get("resume_skills")
    resume_raw_text = ctx.get("resume_raw_text") or ""

    if not job_desc or not job_desc.strip():
        logger.warning("Job %s has no description text.", job_id)
        return {"status": "ABORTED", "reason": "EMPTY_JOB_DESCRIPTION"}

    # Build query text for lexical and semantic retrieval
    # The analyze UI sends only title + raw description, so requiredSkills is usually empty.
    # Fall back to taxonomy skills found in the JD instead of scoring with no requirements.
    stored_req = job_req_skills if isinstance(job_req_skills, list) else []
    stored_pref = job_pref_skills if isinstance(job_pref_skills, list) else []
    # Coverage counts required skills; preferred ones only add a small bonus.
    coverage_req, coverage_pref = resolve_skill_requirements(
        stored_req, stored_pref, job_title, job_desc
    )
    job_req_skills = resolve_required_skills(stored_req, job_title, job_desc)
    skills_text = " ".join(job_req_skills)
    query_text = f"{job_title}\n{skills_text}\n{job_desc}".strip()

    # A resume is PARSED before its separate embedding job has stored any chunks. A match
    # enqueued right after upload would otherwise retrieve nothing and score only on skills
    # (every component 0). Wait for the chunks; if they never come, fail so BullMQ retries.
    # A resume with no text never gets chunks, so it is scored as before.
    if resume_raw_text.strip():
        waited = 0.0
        while await asyncio.to_thread(count_embedded_resume_chunks, resume_id) == 0:
            if waited >= EMBEDDING_WAIT_SECONDS:
                raise ResumeNotEmbeddedError(
                    f"resume {resume_id} has no embedded chunks after {waited:.0f}s"
                )
            await asyncio.sleep(EMBEDDING_POLL_SECONDS)
            waited += EMBEDDING_POLL_SECONDS
        if waited:
            logger.info("Resume %s embeddings ready after %.1fs; scoring", resume_id, waited)

    try:
        # 1. Sparse Lexical Search (BM25-style with GIN index)
        with stage_span("retrieve.bm25"):
            lexical_hits = await asyncio.to_thread(
                search_lexical, query_text, resume_id=resume_id, limit=50
            )

        # 2. Dense Semantic Search (pgvector cosine <=> with HNSW index)
        with stage_span("retrieve.vector"):
            semantic_hits = await asyncio.to_thread(
                search_semantic, query_text, resume_id=resume_id, limit=50
            )

        # 3. Reciprocal Rank Fusion
        fused_chunks = fuse_ranks(lexical_hits, semantic_hits, k=settings.rrf_k)
        rrf_summary = aggregate_resume_rrf(fused_chunks)

        # 4. Cross-Encoder Reranking on top fused candidates
        job_rerank_query = build_bounded_rerank_query(
            job_title, job_req_skills, job_desc, max_tokens=180
        )
        with stage_span("rerank", candidates=min(len(fused_chunks), settings.top_k_candidates)):
            reranked_chunks = await asyncio.to_thread(
                rerank_candidates, job_rerank_query, fused_chunks, top_n=settings.top_k_candidates
            )

        # 5. Skill-Gap Analysis
        skill_gap = analyze_skill_gap(
            coverage_req,
            resume_skills,
            preferred_skills=coverage_pref,
            resume_text=resume_raw_text,
            alternatives=extract_alternative_groups(job_desc),
        )

        # 6. Score aggregation
        scores = compute_match_scores(
            lexical_hits=lexical_hits,
            semantic_hits=semantic_hits,
            reranked_chunks=reranked_chunks,
            skill_gap=skill_gap,
        )
        best_bm25 = scores["best_bm25"]
        best_vector = scores["best_vector"]
        rrf_score = rrf_summary["resume_rrf_score"]
        best_ce_score = scores["best_ce_score"]
        final_score = scores["final_score"]

        scoring_breakdown: dict[str, Any] = {
            "bm25TopScore": best_bm25,
            "vectorSimilarity": best_vector,
            "rrfScore": rrf_score,
            "crossEncoderScore": best_ce_score,
        }
        # Omit coverage when the job has no known requirements: unknown is not 0% or 100%.
        if skill_gap.get("coverage_ratio") is not None:
            scoring_breakdown["skillCoverage"] = skill_gap["coverage_ratio"]

        explanation = {
            "skillGap": skill_gap,
            "scoringBreakdown": scoring_breakdown,
            "topMatchingChunks": [
                {
                    "chunkId": c["chunk_id"],
                    "sectionType": c.get("section_type"),
                    "crossEncoderScore": c.get("cross_encoder_score"),
                    "snippet": c["content"][:250],
                }
                for c in reranked_chunks[:5]
            ],
            "totalChunksEvaluated": len(fused_chunks),
            # Explanation only; not part of the score (see seniority.py)
            "seniority": seniority_fit(job_title, job_desc, resume_raw_text),
            "modelMetadata": {
                "embedder": "all-MiniLM-L6-v2",
                "reranker": "cross-encoder/ms-marco-MiniLM-L-6-v2",
                "scoringVersion": "1.0.0",
                "shift": scores.get("shift", -3.5),
                "temp": scores.get("temp", 2.8),
                "blendWeights": {
                    "w_ce": scores.get("w_ce", 0.65),
                    "w_skill": scores.get("w_skill", 0.25),
                    "w_vec": scores.get("w_vec", 0.10),
                },
                "thresholds": {
                    "strong": 75.0,
                    "weak": 45.0,
                },
            },
        }

        # 7. Atomic persistence to matches table
        match_id = await asyncio.to_thread(
            persist_match_result,
            resume_id=resume_id,
            job_id=job_id,
            bm25_score=best_bm25,
            vector_score=best_vector,
            rrf_score=rrf_score,
            cross_encoder_score=best_ce_score,
            final_score=final_score,
            explanation=explanation,
        )

        # Record production monitoring metrics (score distributions, zero-passage monitor)
        verdict = "strong" if final_score >= 75.0 else ("medium" if final_score >= 45.0 else "weak")
        record_match_metrics(
            final_score=final_score,
            scores=scores,
            verdict=verdict,
            passages_count=len(reranked_chunks),
        )

        await publish_user_event(
            user_id,
            "MATCH_STATUS",
            {
                "jobId": job_id,
                "resumeId": resume_id,
                "status": "COMPLETED",
                "score": final_score,
                "verdict": verdict,
            },
        )

        return {
            "status": "MATCHED",
            "matchId": match_id,
            "resumeId": resume_id,
            "jobId": job_id,
            "finalScore": final_score,
        }

    except MatchTargetGoneError as gone:
        # Normal when a user deletes a resume or job with a match still queued: no retry, no trace
        logger.warning("Skipped match scoring: %s", gone)
        return {
            "status": "SKIPPED",
            "reason": "target_deleted",
            "resumeId": resume_id,
            "jobId": job_id,
        }
    except Exception as e:
        logger.exception("Failed match scoring for resume %s and job %s: %s", resume_id, job_id, e)
        raise e


async def process_analysis(job: Job, token: str | None = None) -> dict[str, Any]:
    """Traced entry point; the span joins the backend request that enqueued the job."""
    with stage_span("job", carrier=queue_carrier(job.data), queue="analysis-queue"):
        return await _process_analysis(job, token)


async def _process_analysis(job: Job, token: str | None = None) -> dict[str, Any]:
    """Processes an analysis job from analysis-queue."""
    data = job.data
    resume_id = data.get("resumeId")
    job_id = data.get("jobId")

    if not resume_id or not job_id:
        logger.warning("Analysis job %s missing resumeId or jobId.", job.id)
        return {"status": "ABORTED", "reason": "MISSING_IDS"}

    try:
        ctx = get_analysis_context(resume_id, job_id)
        if not ctx:
            logger.warning("Analysis context not found for resume %s and job %s", resume_id, job_id)
            return {"status": "ABORTED", "reason": "CONTEXT_NOT_FOUND"}

        if ctx.get("resume_status") != "PARSED":
            logger.warning(
                "Resume %s is not in PARSED status (current: %s)",
                resume_id,
                ctx.get("resume_status"),
            )
            return {"status": "ABORTED", "reason": "RESUME_NOT_PARSED"}

        raw_text = ctx.get("raw_text", "")
        job_desc = ctx.get("job_description", "")
        match_final_score = ctx.get("match_final_score")
        match_explanation = ctx.get("match_explanation") or {}

        if match_final_score is None:
            logger.warning("Match not computed yet for resume %s and job %s", resume_id, job_id)
            return {"status": "ABORTED", "reason": "MATCH_NOT_COMPUTED"}

        # 1. PII Redaction & Prompt-Injection Detection
        candidate_name = ctx.get("candidate_name")
        resume_redaction = redact_pii(raw_text, candidate_name=candidate_name)
        jd_redaction = redact_pii(job_desc)

        injection_suspected = detect_prompt_injection(raw_text) or detect_prompt_injection(job_desc)

        # 2. Deterministic Score Injection (LLM never sees or edits scores)
        final_score = float(match_final_score)
        ats_score = float(ctx["ats_score"]) if ctx.get("ats_score") is not None else None

        verdict_band: Literal["strong", "medium", "weak"]
        if final_score >= DEFAULT_STRONG_THRESHOLD:
            verdict_band = "strong"
        elif final_score >= DEFAULT_WEAK_THRESHOLD:
            verdict_band = "medium"
        else:
            verdict_band = "weak"

        skill_gap_data = match_explanation.get("skillGap", {})
        matched_skills = skill_gap_data.get("matched", [])
        missing_skills = skill_gap_data.get("missing", [])
        partial_skills = skill_gap_data.get("partial", [])

        # 3. LLM Gateway Execution or Graceful Degradation
        configured_tiers = llm_settings.get_configured_tiers()
        require_llm = os.getenv("REQUIRE_LLM", "").strip() == "1"
        structured_result: StructuredAnalysisResult

        if not configured_tiers:
            if require_llm:
                raise RuntimeError(
                    "REQUIRE_LLM=1 but no LLM provider keys are configured. "
                    "Set at least one of: GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY."
                )
            logger.info(
                "No LLM provider keys configured. "
                "Returning deterministic-only analysis for resume %s",
                resume_id,
            )
            structured_result = StructuredAnalysisResult(
                summary=(
                    "Deterministic scoring completed. "
                    "LLM multi-tier analysis is currently unavailable."
                ),
                strengths=[],
                gaps=[],
                prioritized_improvements=[],
                match_score=final_score,
                ats_score=ats_score,
                verdict_band=verdict_band,
                matched_skills=matched_skills,
                missing_skills=missing_skills,
                partial_skills=partial_skills,
                llm_status="UNAVAILABLE",
                provider=None,
                model=None,
                prompt_version=PROMPT_VERSION,
                tokens_prompt=0,
                tokens_completion=0,
                latency_ms=0,
                fabricated_evidence_rate=0.0,
                injection_suspected=injection_suspected,
            )
        else:
            try:
                exec_res = await llm_gateway.execute(
                    redaction=resume_redaction,
                    redacted_jd=jd_redaction.redacted_text,
                )
                structured_result = StructuredAnalysisResult(
                    summary=exec_res.llm_response.summary,
                    strengths=exec_res.verified_strengths,
                    gaps=exec_res.llm_response.gaps,
                    prioritized_improvements=exec_res.llm_response.prioritized_improvements,
                    match_score=final_score,
                    ats_score=ats_score,
                    verdict_band=verdict_band,
                    matched_skills=matched_skills,
                    missing_skills=missing_skills,
                    partial_skills=partial_skills,
                    llm_status="SUCCESS",
                    provider=exec_res.provider,
                    model=exec_res.model,
                    prompt_version=PROMPT_VERSION,
                    tokens_prompt=exec_res.tokens_prompt,
                    tokens_completion=exec_res.tokens_completion,
                    latency_ms=exec_res.latency_ms,
                    fabricated_evidence_rate=exec_res.fabricated_rate,
                    injection_suspected=injection_suspected,
                )
            except LLMUnavailableError as unavail_err:
                if require_llm:
                    raise RuntimeError(
                        f"REQUIRE_LLM=1 but all LLM tiers exhausted: {unavail_err}"
                    ) from unavail_err
                logger.warning(
                    "All LLM tiers exhausted or unavailable (%s). "
                    "Falling back to deterministic analysis.",
                    unavail_err,
                )
                structured_result = StructuredAnalysisResult(
                    summary=(
                        "LLM analysis provider unavailable; "
                        "falling back to deterministic matching insights."
                    ),
                    strengths=[],
                    gaps=[],
                    prioritized_improvements=[],
                    match_score=final_score,
                    ats_score=ats_score,
                    verdict_band=verdict_band,
                    matched_skills=matched_skills,
                    missing_skills=missing_skills,
                    partial_skills=partial_skills,
                    llm_status="UNAVAILABLE",
                    provider=None,
                    model=None,
                    prompt_version=PROMPT_VERSION,
                    tokens_prompt=0,
                    tokens_completion=0,
                    latency_ms=0,
                    fabricated_evidence_rate=0.0,
                    injection_suspected=injection_suspected,
                )

        # 4. Atomic Idempotent Persistence
        analysis_id = persist_analysis_result(
            resume_id=resume_id,
            job_id=job_id,
            result=structured_result.model_dump(by_alias=True),
            llm_status=structured_result.llm_status,
            provider=structured_result.provider,
            model=structured_result.model,
            prompt_version=structured_result.prompt_version,
            tokens_prompt=structured_result.tokens_prompt,
            tokens_completion=structured_result.tokens_completion,
            latency_ms=structured_result.latency_ms,
            fabricated_evidence_rate=structured_result.fabricated_evidence_rate,
            injection_suspected=structured_result.injection_suspected,
            score=final_score,
            skill_gap=skill_gap_data,
            ats_findings=ctx.get("ats_hazards"),
            status="COMPLETED",
        )

        return {
            "status": "COMPLETED",
            "analysisId": analysis_id,
            "resumeId": resume_id,
            "jobId": job_id,
            "llmStatus": structured_result.llm_status,
        }

    except Exception as e:
        logger.exception(
            "Failed processing analysis for resume %s and job %s: %s",
            resume_id,
            job_id,
            e,
        )
        raise e


def warm_models() -> None:
    """Loads both transformer models before any worker starts consuming jobs.

    Lazy loading on the first job blocked the event loop ~30 s per model.
    """
    started = time.monotonic()
    if settings.torch_num_threads:
        import torch

        # Must run before the first inference to take effect
        torch.set_num_threads(settings.torch_num_threads)
        logger.info("torch intra-op threads capped at %d", settings.torch_num_threads)
    get_embedder()
    get_cross_encoder()
    logger.info("ML models preloaded in %.1fs", time.monotonic() - started)


HEARTBEAT_TTL_SECONDS = 15
HEARTBEAT_INTERVAL_SECONDS = 5


def get_worker_id() -> str:
    return os.environ.get("WORKER_ID") or socket.gethostname() or "default-worker"


async def run_heartbeat_loop(worker_id: str, roles: set[str]) -> None:
    """Periodically refreshes the worker's heartbeat in Redis with a 15-second TTL.

    The healthcheck script (ml/healthcheck_worker.py) verifies that this key exists
    and is recent, ensuring the asyncio event loop is not blocked or deadlocked.
    """
    heartbeat_key = f"resumatch:worker:heartbeat:{worker_id}"
    try:
        redis_client = aioredis.from_url(settings.redis_url)
    except Exception as e:
        logger.warning("Failed to initialize Redis client for worker heartbeat: %s", e)
        return

    try:
        while not _should_exit:
            payload = json.dumps({
                "worker_id": worker_id,
                "roles": sorted(roles),
                "timestamp": time.time(),
                "status": "healthy",
                "pid": os.getpid(),
            })
            try:
                await redis_client.set(heartbeat_key, payload, ex=HEARTBEAT_TTL_SECONDS)
            except Exception as e:
                logger.warning("Worker heartbeat write to Redis failed: %s", e)
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
    except asyncio.CancelledError:
        pass
    finally:
        try:
            await redis_client.delete(heartbeat_key)
        except Exception:
            pass
        await redis_client.aclose()


async def main_async() -> None:
    global _parse_worker, _embed_worker, _match_worker, _analysis_worker, _ocr_worker
    redis_opts = {"connection": settings.redis_url, "prefix": "bull", "concurrency": 2}
    roles = served_queues(settings.worker_queues, settings.ocr_queue_enabled)

    init_telemetry("resumatch-ml-worker")
    # Parse/OCR-only processes never run the transformer models
    if roles & {"embed", "match", "analysis"}:
        await asyncio.to_thread(warm_models)

    logger.info("Starting BullMQ workers for roles: %s", ", ".join(sorted(roles)))
    if "parse" in roles:
        _parse_worker = Worker("resume-parsing-queue", process_parse_document, redis_opts)
    if "ocr" in roles:
        # One OCR job at a time per process: concurrent PyMuPDF/Tesseract use hung in load tests
        _ocr_worker = Worker(OCR_QUEUE_NAME, process_ocr_document, {**redis_opts, "concurrency": 1})
    if "embed" in roles:
        _embed_worker = Worker("embedding-queue", process_embed_document, redis_opts)
    if "match" in roles:
        _match_worker = Worker("match-scoring-queue", process_match_scoring, redis_opts)
    if "analysis" in roles:
        _analysis_worker = Worker("analysis-queue", process_analysis, redis_opts)

    worker_id = get_worker_id()
    heartbeat_task = asyncio.create_task(run_heartbeat_loop(worker_id, roles))
    logger.info("Worker heartbeat started for %s (roles: %s)", worker_id, ", ".join(sorted(roles)))

    # Keep alive until shutdown requested
    while not _should_exit:
        await asyncio.sleep(1)

    heartbeat_task.cancel()
    try:
        await heartbeat_task
    except asyncio.CancelledError:
        pass

    logger.info("Closing BullMQ workers...")
    if _parse_worker:
        await _parse_worker.close()
    if _embed_worker:
        await _embed_worker.close()
    if _match_worker:
        await _match_worker.close()
    if _analysis_worker:
        await _analysis_worker.close()
    if _ocr_worker:
        await _ocr_worker.close()
    if _embedding_queue:
        await _embedding_queue.close()
    if _ocr_queue:
        await _ocr_queue.close()
    logger.info("All BullMQ workers closed.")


def handle_shutdown(signum: int, frame: FrameType | None) -> None:
    global _should_exit
    logger.info("Received signal %s. Initiating graceful shutdown...", signum)
    _should_exit = True


def main() -> None:
    signal.signal(signal.SIGINT, handle_shutdown)
    signal.signal(signal.SIGTERM, handle_shutdown)
    asyncio.run(main_async())


if __name__ == "__main__":
    main()
