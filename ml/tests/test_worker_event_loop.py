"""
Phase 10B regression: blocking work in a job handler must not freeze the shared event loop.

All four BullMQ workers in ml/worker.py share one asyncio loop. When model inference ran
directly on it, every other worker's Redis wait stalled (docs/PERFORMANCE.md, Finding 1).
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any, cast

import pytest
from bullmq import Job

import ml.worker as worker

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


def test_warm_models_loads_both_models(monkeypatch: pytest.MonkeyPatch) -> None:
    loaded: list[str] = []
    monkeypatch.setattr(worker, "get_embedder", lambda: loaded.append("embedder"))
    monkeypatch.setattr(worker, "get_cross_encoder", lambda: loaded.append("cross_encoder"))

    worker.warm_models()

    assert loaded == ["embedder", "cross_encoder"]
