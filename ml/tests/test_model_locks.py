"""
Phase 10B regression: model and tokenizer calls must never run concurrently.

Fast (Rust) tokenizers raise "RuntimeError: Already borrowed" when two threads use the same
tokenizer at once. ml/worker.py runs model calls via asyncio.to_thread, so a resume embedding
and a job embedding crashed each other under load (docs/PERFORMANCE.md, Finding 4).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from ml.pipelines.embeddings import embedder
from ml.pipelines.matching import reranker


def _peak_concurrency(decorator: Callable[[Callable[..., Any]], Callable[..., Any]]) -> int:
    active = 0
    peak = 0
    counter = threading.Lock()

    @decorator
    def model_call() -> None:
        nonlocal active, peak
        with counter:
            active += 1
            peak = max(peak, active)
        time.sleep(0.05)
        with counter:
            active -= 1

    threads = [threading.Thread(target=model_call) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return peak


@pytest.mark.parametrize(
    "decorator",
    [embedder._with_model_lock, reranker._with_cross_encoder_lock],
    ids=["embedder", "cross_encoder"],
)
def test_lock_serializes_calls_across_threads(
    decorator: Callable[[Callable[..., Any]], Callable[..., Any]],
) -> None:
    assert _peak_concurrency(decorator) == 1


@pytest.mark.parametrize(
    "fn",
    [
        embedder.get_embedder,
        embedder.generate_embeddings,
        embedder.embed_query_text,
        reranker.get_cross_encoder,
        reranker.build_bounded_rerank_query,
        reranker.rerank_candidates,
    ],
    ids=lambda f: f.__name__,
)
def test_every_model_entry_point_holds_its_lock(fn: Callable[..., Any]) -> None:
    # functools.wraps sets __wrapped__ only when the function went through a lock decorator.
    assert hasattr(fn, "__wrapped__"), f"{fn.__name__} is not wrapped by its model lock"


def test_locks_are_reentrant() -> None:
    # embed_query_text calls generate_embeddings, so the same thread re-acquires MODEL_LOCK.
    with embedder.MODEL_LOCK:
        assert embedder.MODEL_LOCK.acquire(timeout=1)
        embedder.MODEL_LOCK.release()
