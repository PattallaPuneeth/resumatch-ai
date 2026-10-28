"""
Phase 10B regression: blocking work in a job handler must not freeze the shared event loop.

All four BullMQ workers in ml/worker.py share one asyncio loop. When model inference ran
directly on it, every other worker's Redis wait stalled (docs/PERFORMANCE.md, Finding 1).
"""

from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from typing import Any, cast

import pytest
from bullmq import Job

import ml.worker as worker
from ml.config import settings
from ml.pipelines.intake.exceptions import OcrDeferredError

BLOCK_SECONDS = 0.6
TICK_SECONDS = 0.05


async def _count_ticks_while(coro: Any) -> tuple[Any, int]:
    """Runs `coro` while a ticker coroutine counts how often the loop lets it run."""
    ticks = 0
    done = asyncio.Event()

    async def ticker() -> None:
        nonlocal ticks
        while not done.is_set():
            await asyncio.sleep(TICK_SECONDS)
            ticks += 1

    tick_task = asyncio.create_task(ticker())
    try:
        result = await coro
    finally:
        done.set()
        await tick_task
    return result, ticks


@pytest.mark.asyncio
async def test_embedding_inference_does_not_block_event_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def slow_embeddings(chunks: list[Any]) -> list[Any]:
        time.sleep(BLOCK_SECONDS)  # stands in for CPU-bound model inference
        return []

    monkeypatch.setattr(
        worker, "get_job_data", lambda job_id: {"rawDescription": "Senior Python engineer role."}
    )
    monkeypatch.setattr(worker, "generate_chunk_embeddings", slow_embeddings)
    monkeypatch.setattr(worker, "persist_job_chunks", lambda job_id, vectors: 0)

    job = cast(Job, SimpleNamespace(id="t-embed", data={"entityType": "JOB", "jobId": "job-1"}))
    result, ticks = await _count_ticks_while(worker.process_embed_document(job))

    assert result["status"] == "EMBEDDED"
    # A free loop ticks ~BLOCK_SECONDS / TICK_SECONDS (12) times; a blocked loop ticks ~0.
    assert ticks >= 6, f"event loop only ticked {ticks} times during blocking inference"


@pytest.mark.asyncio
async def test_parse_jobs_never_run_parse_document_concurrently(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """PyMuPDF isn't thread-safe; concurrent OCR jobs hung for minutes under load."""
    active = 0
    peak = 0
    lock = threading.Lock()

    def tracking_parse(*args: Any, **kwargs: Any) -> Any:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.2)
        with lock:
            active -= 1
        return SimpleNamespace(extraction_method="OCR", ats_score=80.0, page_count=1)

    async def no_enqueue(resume_id: str) -> None:
        return None

    monkeypatch.setattr(worker, "get_resume_status", lambda rid: ("UPLOADED", None))
    monkeypatch.setattr(worker, "update_resume_status", lambda rid, status: True)
    monkeypatch.setattr(worker, "download_file", lambda key, path, bucket=None: None)
    monkeypatch.setattr(worker, "parse_document", tracking_parse)
    monkeypatch.setattr(worker, "save_parsed_resume", lambda rid, result: True)
    monkeypatch.setattr(worker, "enqueue_embed_job", no_enqueue)

    jobs = [
        cast(
            Job,
            SimpleNamespace(
                id=f"t-parse-{i}", data={"resumeId": f"r{i}", "storageKey": f"k{i}.pdf"}
            ),
        )
        for i in range(3)
    ]
    results, ticks = await _count_ticks_while(
        asyncio.gather(*(worker.process_parse_document(j) for j in jobs))
    )

    assert [r["status"] for r in results] == ["PARSED"] * 3
    assert peak == 1, f"parse_document ran {peak} times concurrently"
    assert ticks >= 6, "event loop was blocked while parses ran"


def test_warm_models_loads_both_models(monkeypatch: pytest.MonkeyPatch) -> None:
    loaded: list[str] = []
    monkeypatch.setattr(worker, "get_embedder", lambda: loaded.append("embedder"))
    monkeypatch.setattr(worker, "get_cross_encoder", lambda: loaded.append("cross_encoder"))

    worker.warm_models()

    assert loaded == ["embedder", "cross_encoder"]


def _parse_job_mocks(monkeypatch: pytest.MonkeyPatch, status: str) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"status": [], "ocr_enqueued": [], "embed": [], "parse": []}

    def fake_parse(*args: Any, **kwargs: Any) -> Any:
        calls["parse"].append(kwargs.get("allow_ocr", True))
        if not kwargs.get("allow_ocr", True):
            kwargs["status_callback"]("NEEDS_OCR")
            raise OcrDeferredError("needs OCR")
        return SimpleNamespace(extraction_method="OCR", ats_score=70.0, page_count=1)

    async def fake_enqueue_ocr(data: dict[str, Any], resume_id: str) -> None:
        calls["ocr_enqueued"].append(resume_id)

    async def fake_enqueue_embed(resume_id: str) -> None:
        calls["embed"].append(resume_id)

    def fake_status(rid: str, s: str) -> bool:
        calls["status"].append(s)
        return True

    monkeypatch.setattr(worker, "get_resume_status", lambda rid: (status, None))
    monkeypatch.setattr(worker, "update_resume_status", fake_status)
    monkeypatch.setattr(worker, "download_file", lambda key, path, bucket=None: None)
    monkeypatch.setattr(worker, "parse_document", fake_parse)
    monkeypatch.setattr(worker, "save_parsed_resume", lambda rid, result: True)
    monkeypatch.setattr(worker, "enqueue_ocr_job", fake_enqueue_ocr)
    monkeypatch.setattr(worker, "enqueue_embed_job", fake_enqueue_embed)
    return calls


@pytest.mark.asyncio
async def test_parse_job_hands_scans_to_ocr_queue_when_enabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ocr_queue_enabled", True)
    calls = _parse_job_mocks(monkeypatch, "UPLOADED")
    job = cast(Job, SimpleNamespace(id="p1", data={"resumeId": "r1", "storageKey": "k.pdf"}))

    result = await worker.process_parse_document(job)

    assert result["status"] == "NEEDS_OCR"
    assert calls["parse"] == [False]
    assert calls["ocr_enqueued"] == ["r1"] and calls["embed"] == []
    assert calls["status"] == ["EXTRACTING", "NEEDS_OCR"]


@pytest.mark.asyncio
async def test_ocr_job_continues_from_needs_ocr_and_parses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _parse_job_mocks(monkeypatch, "NEEDS_OCR")
    job = cast(Job, SimpleNamespace(id="o1", data={"resumeId": "r1", "storageKey": "k.pdf"}))

    result = await worker.process_ocr_document(job)

    assert result["status"] == "PARSED"
    assert calls["parse"] == [True]
    assert "EXTRACTING" not in calls["status"]  # NEEDS_OCR -> EXTRACTING is not a legal move
    assert calls["embed"] == ["r1"]


@pytest.mark.asyncio
async def test_parse_job_runs_ocr_inline_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ocr_queue_enabled", False)
    calls = _parse_job_mocks(monkeypatch, "UPLOADED")
    job = cast(Job, SimpleNamespace(id="p2", data={"resumeId": "r2", "storageKey": "k.pdf"}))

    result = await worker.process_parse_document(job)

    assert result["status"] == "PARSED" and calls["ocr_enqueued"] == []


def test_served_queues_parses_worker_roles() -> None:
    assert worker.served_queues("all") == set(worker.ALL_QUEUES)
    assert worker.served_queues(" OCR ") == {"ocr"}
    assert "ocr" not in worker.served_queues("all", ocr_queue_enabled=True)
    assert worker.served_queues("ocr", ocr_queue_enabled=True) == {"ocr"}
    assert worker.served_queues("parse,embed,match,analysis") == {
        "parse",
        "embed",
        "match",
        "analysis",
    }
    with pytest.raises(ValueError):
        worker.served_queues("parse,unknown")
