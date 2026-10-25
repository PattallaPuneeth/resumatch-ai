"""
Phase 3B & 3C-1: Modular Match Scoring and Configurable Calibration.

Provides deterministic composite scoring combining cross-encoder reranking,
skill coverage, and semantic vector similarity.
Supports configurable shift, temperature, and blend weights for evaluation and calibration
with production defaults:
shift=-3.5, temp=2.8, w_ce=0.65, w_skill=0.25, w_vec=0.10.
"""

from __future__ import annotations

import math
from typing import Any

DEFAULT_SHIFT = -3.5
DEFAULT_TEMP = 2.8
DEFAULT_W_CE = 0.65
DEFAULT_W_SKILL = 0.25
DEFAULT_W_VEC = 0.10


def calibrate_ce_logit(
    logit: float,
    shift: float = DEFAULT_SHIFT,
    temp: float = DEFAULT_TEMP,
) -> float:
    """
    Normalizes raw cross-encoder logit to 0-100 score using sigmoid:
        scaled = (clamped_logit - shift) / temp
        score = 1 / (1 + exp(-scaled)) * 100
    """
    clamped_logit = max(-25.0, min(25.0, logit))
    scaled = (clamped_logit - shift) / temp
    clamped_scaled = max(-15.0, min(15.0, scaled))
    prob = 1.0 / (1.0 + math.exp(-clamped_scaled))
    return round(prob * 100.0, 2)


def compute_match_scores(
    lexical_hits: list[dict[str, Any]],
    semantic_hits: list[dict[str, Any]],
    reranked_chunks: list[dict[str, Any]],
    skill_gap: dict[str, Any],
    shift: float = DEFAULT_SHIFT,
    temp: float = DEFAULT_TEMP,
    w_ce: float = DEFAULT_W_CE,
    w_skill: float = DEFAULT_W_SKILL,
    w_vec: float = DEFAULT_W_VEC,
) -> dict[str, Any]:
    """
    Computes component scores and composite final score.

    Args:
        lexical_hits: List of chunks retrieved via sparse lexical search.
        semantic_hits: List of chunks retrieved via dense semantic search.
        reranked_chunks: Candidates scored by CrossEncoder with 'cross_encoder_logit'.
        skill_gap: Output dictionary from analyze_skill_gap().
        shift: Cross-encoder sigmoid center shift (default: -3.5).
        temp: Cross-encoder sigmoid temperature (default: 2.8).
        w_ce: Weight for Cross-Encoder score (default: 0.65).
        w_skill: Weight for skill coverage score (default: 0.25).
        w_vec: Weight for semantic vector similarity score (default: 0.10).

    Returns:
        Dict containing best_bm25, best_vector, best_ce_score, skill_coverage,
        best_ce_logit, and final_score.
    """
    best_bm25 = round(max([c["score"] for c in lexical_hits]), 4) if lexical_hits else 0.0
    best_vector = round(max([c["score"] for c in semantic_hits]), 4) if semantic_hits else 0.0
    coverage = float(skill_gap.get("coverage_ratio", 1.0))

    if reranked_chunks:
        # Use raw cross_encoder_logit if available to re-calibrate with custom shift/temp
        best_logit: float = max(float(c.get("cross_encoder_logit", 0.0)) for c in reranked_chunks)
        best_ce_score = calibrate_ce_logit(best_logit, shift=shift, temp=temp)
    else:
        best_logit = -25.0
        best_ce_score = 0.0

    # Composite blend formula
    final_score = round(
        w_ce * best_ce_score + w_skill * (coverage * 100.0) + w_vec * max(0.0, best_vector * 100.0),
        2,
    )
    final_score = max(0.0, min(100.0, final_score))

    return {
        "best_bm25": best_bm25,
        "best_vector": best_vector,
        "best_ce_logit": best_logit,
        "best_ce_score": best_ce_score,
        "skill_coverage": coverage,
        "final_score": final_score,
        "shift": shift,
        "temp": temp,
        "w_ce": w_ce,
        "w_skill": w_skill,
        "w_vec": w_vec,
    }
