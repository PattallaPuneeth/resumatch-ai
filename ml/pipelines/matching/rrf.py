"""
Phase 3B: Reciprocal Rank Fusion (RRF).

Combines sparse lexical rankings and dense semantic rankings using:
    RRF_Score(d) = Σ_m (1 / (k + rank_m(d)))
with default smoothing constant k = 60.

Includes deterministic tie-breaking and chunk-to-resume aggregation.
"""

from __future__ import annotations

from typing import Any

from ml.config import settings


def fuse_ranks(
    lexical_results: list[dict[str, Any]],
    semantic_results: list[dict[str, Any]],
    k: int | None = None,
) -> list[dict[str, Any]]:
    """
    Fuses lexical and semantic rankings at the chunk level.

    Args:
        lexical_results: List of chunk hits with 'chunk_id', 'rank' (1-indexed).
        semantic_results: List of chunk hits with 'chunk_id', 'rank' (1-indexed).
        k: Smoothing constant (default: 60 from settings.rrf_k).

    Returns:
        List of merged chunks with 'rrf_score', 'lexical_rank', 'semantic_rank',
        sorted deterministically by (rrf_score DESC, chunk_id ASC).
    """
    smoothing_k = k if k is not None else settings.rrf_k

    # chunk_id -> {chunk data, rrf_score, lexical_rank, semantic_rank}
    fused: dict[str, dict[str, Any]] = {}

    for idx, item in enumerate(lexical_results, start=1):
        cid = item["chunk_id"]
        rank = item.get("rank", idx)
        entry = dict(item)
        entry["lexical_rank"] = rank
        entry["semantic_rank"] = None
        entry["lexical_score"] = item.get("score", 0.0)
        entry["semantic_score"] = 0.0
        entry["rrf_score"] = 1.0 / (smoothing_k + rank)
        fused[cid] = entry

    for idx, item in enumerate(semantic_results, start=1):
        cid = item["chunk_id"]
        rank = item.get("rank", idx)
        sem_contrib = 1.0 / (smoothing_k + rank)
        if cid in fused:
            fused[cid]["semantic_rank"] = rank
            fused[cid]["semantic_score"] = item.get("score", 0.0)
            fused[cid]["rrf_score"] += sem_contrib
        else:
            entry = dict(item)
            entry["lexical_rank"] = None
            entry["semantic_rank"] = rank
            entry["lexical_score"] = 0.0
            entry["semantic_score"] = item.get("score", 0.0)
            entry["rrf_score"] = sem_contrib
            fused[cid] = entry

    # Deterministic tie-breaking: rrf_score descending, chunk_id ascending
    sorted_chunks = sorted(
        fused.values(),
        key=lambda x: (-x["rrf_score"], x["chunk_id"]),
    )

    # Re-assign fused rank
    for idx, item in enumerate(sorted_chunks, start=1):
        item["fused_rank"] = idx

    return sorted_chunks


def aggregate_resume_rrf(
    fused_chunks: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Aggregates chunk-level RRF scores for a single (job, resume) pair.

    The resume RRF score combines the peak chunk match with contextual depth:
        resume_rrf = max(chunk_rrf) + 0.25 * mean(top_3_chunks_rrf)

    Returns:
        dict with {
            'resume_rrf_score': float,
            'max_chunk_rrf': float,
            'top_chunks': list[dict],
            'chunk_count': int
        }
    """
    if not fused_chunks:
        return {
            "resume_rrf_score": 0.0,
            "max_chunk_rrf": 0.0,
            "top_chunks": [],
            "chunk_count": 0,
        }

    chunk_scores = [c["rrf_score"] for c in fused_chunks]
    max_chunk = max(chunk_scores)
    top_3 = chunk_scores[:3]
    mean_top_3 = sum(top_3) / len(top_3)

    combined_score = round(max_chunk + 0.25 * mean_top_3, 6)

    return {
        "resume_rrf_score": combined_score,
        "max_chunk_rrf": round(max_chunk, 6),
        "top_chunks": fused_chunks,
        "chunk_count": len(fused_chunks),
    }
