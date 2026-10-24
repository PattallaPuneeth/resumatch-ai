import asyncio
import logging
import os
import signal
from types import FrameType
from typing import Any

from bullmq import Job, Worker

from ml.config import settings
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

_worker: Worker | None = None
_should_exit = False


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


async def main_async() -> None:
    global _worker
    redis_opts = {"connection": settings.redis_url, "prefix": "bull", "concurrency": 2}

    logger.info("Starting BullMQ Worker for queue 'resume-parsing-queue' with prefix 'bull'...")
    _worker = Worker("resume-parsing-queue", process_parse_document, redis_opts)

    # Keep alive until shutdown requested
    while not _should_exit:
        await asyncio.sleep(1)

    if _worker:
        logger.info("Closing BullMQ worker...")
        await _worker.close()
        logger.info("BullMQ worker closed.")


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
