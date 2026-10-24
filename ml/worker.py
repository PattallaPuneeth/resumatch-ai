import asyncio
import logging
import os
import signal
from types import FrameType
from typing import Any

from bullmq import Job, Queue, Worker  # type: ignore[import-untyped]

from ml.config import settings
from ml.pipelines.embeddings.chunker import chunk_resume_text
from ml.pipelines.embeddings.embedder import generate_chunk_embeddings
from ml.pipelines.embeddings.repository import (
    get_parsed_resume_data,
    persist_resume_chunks,
    record_embedding_error,
)
from ml.pipelines.intake.exceptions import (
    CorruptFileError,
    EncryptedPdfError,
    StorageObjectNotFoundError,
    TextTooShortAfterOcrError,
    TooManyPagesError,
    UnsupportedTypeError,
)
from ml.pipelines.intake.parser import parse_document
from ml.pipelines.intake.repository import (
    mark_resume_failed,
    save_parsed_resume,
    update_resume_status,
)
from ml.storage.s3 import download_file

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("resumatch-ml-worker")

_parse_worker: Worker | None = None
_embed_worker: Worker | None = None
_embedding_queue: Queue | None = None
_should_exit = False


def get_embedding_queue() -> Queue:
    """Returns singleton Queue producer for embedding-queue."""
    global _embedding_queue
    if _embedding_queue is None:
        _embedding_queue = Queue(
            "embedding-queue",
            {"connection": settings.redis_url, "prefix": "bull"},
        )
    return _embedding_queue


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
        logger.exception(
            "Failed to enqueue EMBED_DOCUMENT job for resume %s: %s", resume_id, q_err
        )


async def process_parse_document(job: Job, token: str | None = None) -> dict[str, Any]:
    """Processes a PARSE_DOCUMENT job from resume-parsing-queue."""
    data = job.data
    resume_id = data.get("resumeId")
    storage_key = data.get("storageKey") or data.get("s3Key")
    bucket = data.get("bucket", settings.s3_bucket)
    mime_type = data.get("mimeType", "application/pdf")

    if not resume_id or not storage_key:
        logger.error("Job %s missing resumeId or storageKey", job.id)
        raise ValueError("Invalid job payload: missing resumeId or storageKey")

    logger.info("Processing resume parsing job %s for resume %s", job.id, resume_id)

    # 1. Update status to EXTRACTING (or abort if resume was deleted)
    if not update_resume_status(resume_id, "EXTRACTING"):
        logger.info(
            "Resume %s was deleted prior to processing. Aborting job %s.", resume_id, job.id
        )
        return {"status": "ABORTED", "reason": "RESUME_DELETED"}

    # Determine local temp path
    ext = storage_key.split(".")[-1].lower() if "." in storage_key else "pdf"
    temp_dir = "/tmp" if os.path.exists("/tmp") else os.path.abspath("./tmp")
    os.makedirs(temp_dir, exist_ok=True)
    temp_file = os.path.join(temp_dir, f"resume_{resume_id}.{ext}")

    try:
        # 2. Download from S3 storage
        try:
            download_file(storage_key, temp_file, bucket=bucket)
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
        result = parse_document(temp_file, mime_type, status_callback=on_status_change)

        # 5. Persist results and transition to PARSED
        persisted = save_parsed_resume(resume_id, result)
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
    """Processes an EMBED_DOCUMENT job from embedding-queue."""
    data = job.data
    entity_type = data.get("entityType", "RESUME")

    if entity_type == "JOB":
        logger.warning(
            "Job embedding is deferred to Phase 3B (job descriptions and hybrid matching). Aborting job %s.",
            job.id,
        )
        return {"status": "ABORTED", "reason": "JOB_EMBEDDING_DEFERRED_PHASE3B"}

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
        chunk_vectors = generate_chunk_embeddings(chunks)

        # 4. Atomically persist chunks to database
        saved_count = persist_resume_chunks(resume_id, chunk_vectors)

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


async def main_async() -> None:
    global _parse_worker, _embed_worker
    redis_opts = {"connection": settings.redis_url, "prefix": "bull", "concurrency": 2}

    logger.info("Starting BullMQ Workers for 'resume-parsing-queue' and 'embedding-queue'...")
    _parse_worker = Worker("resume-parsing-queue", process_parse_document, redis_opts)
    _embed_worker = Worker("embedding-queue", process_embed_document, redis_opts)

    # Keep alive until shutdown requested
    while not _should_exit:
        await asyncio.sleep(1)

    logger.info("Closing BullMQ workers...")
    if _parse_worker:
        await _parse_worker.close()
    if _embed_worker:
        await _embed_worker.close()
    if _embedding_queue:
        await _embedding_queue.close()
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
