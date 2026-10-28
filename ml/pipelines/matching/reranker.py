"""
Phase 3B: Cross-Encoder Reranking.

Reranks the top fused candidates using cross-encoder/ms-marco-MiniLM-L-6-v2.
Enforces sequence length validation (max 512 tokens) and calibrated 0–100 score normalization.
"""

from __future__ import annotations

import functools
import logging
import math
import threading
from collections.abc import Callable
from typing import Any, ParamSpec, TypeVar

from ml.config import settings
from sentence_transformers import CrossEncoder

logger = logging.getLogger("resumatch-ml-reranker")

_CROSS_ENCODER: CrossEncoder | None = None

# Fast (Rust) tokenizers raise "RuntimeError: Already borrowed" when two threads use the same
# tokenizer at once, and the worker runs model calls in threads (asyncio.to_thread). Every use of
# the model or its tokenizer therefore holds this re-entrant lock (docs/PERFORMANCE.md, Finding 4).
CROSS_ENCODER_LOCK = threading.RLock()

P = ParamSpec("P")
R = TypeVar("R")

def _with_cross_encoder_lock(fn: Callable[P, R]) -> Callable[P, R]:
    @functools.wraps(fn)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        with CROSS_ENCODER_LOCK:
            return fn(*args, **kwargs)

    return wrapper

MAX_CROSS_ENCODER_SEQ_LENGTH = 512


@_with_cross_encoder_lock
def get_cross_encoder() -> CrossEncoder:
    """Returns singleton CrossEncoder instance."""
    global _CROSS_ENCODER
    if _CROSS_ENCODER is None:
        model_name = getattr(
            settings,
            "reranker_model_name",
            "cross-encoder/ms-marco-MiniLM-L-6-v2",
        )
        logger.info("Loading CrossEncoder model singleton: %s", model_name)
        _CROSS_ENCODER = CrossEncoder(model_name, max_length=MAX_CROSS_ENCODER_SEQ_LENGTH)
    return _CROSS_ENCODER


def normalize_cross_encoder_logit(
    logit: float,
    shift: float = -3.5,
    temp: float = 2.8,
) -> float:
    """
    Normalizes raw cross-encoder logit from ms-marco-MiniLM-L-6-v2 to a
    calibrated 0–100 match score.

    MS MARCO models produce logit distributions centered significantly lower
    than standard classification models:
    - Highly relevant / strong matches: logits in [+1.5, +5.5] -> 80% to 98%
    - Moderately relevant / partial matches: logits in [-5.5, +0.0] -> 30% to 75%
    - Irrelevant matches (e.g. marketing vs backend): logits <= -10.0 -> < 10%

    Applies temperature and centering shift:
        scaled = (logit - shift) / temp
        prob = 1 / (1 + exp(-scaled))
        score = prob * 100
    """
    clamped_logit = max(-25.0, min(25.0, logit))
    scaled = (clamped_logit - shift) / temp
    clamped_scaled = max(-15.0, min(15.0, scaled))
    prob = 1.0 / (1.0 + math.exp(-clamped_scaled))
    return round(prob * 100.0, 2)


_REQUIREMENT_HEADING_KEYWORDS = (
    "requirement",
    "qualification",
    "skills",
    "what you'll need",
    "what you will need",
    "must have",
    "you have",
    "you bring",
)


def _is_heading_line(line: str) -> bool:
    """Short lines without sentence punctuation are treated as section headings."""
    stripped = line.strip().rstrip(":")
    return (
        0 < len(stripped.split()) <= 5
        and not stripped.endswith(".")
        and not stripped.startswith(("-", "*", "•"))
    )


def _extract_requirement_excerpt(raw_description: str) -> str:
    """
    Returns the body lines of requirement-like sections ("Required Skills", "Qualifications", ...)
    plus any inline "experience with" line. Heading lines themselves are never returned on their
    own: a query made only of headings ("Required Skills Preferred Skills") carries no signal.
    Falls back to the first content lines of the description.
    """
    lines = [line.strip() for line in raw_description.splitlines() if line.strip()]
    captured: list[str] = []
    in_requirements = False
    for line in lines:
        lower = line.lower()
        if _is_heading_line(line):
            in_requirements = any(k in lower for k in _REQUIREMENT_HEADING_KEYWORDS)
            continue
        if in_requirements or "experience with" in lower:
            captured.append(line.lstrip("-*• ").strip())

    if captured:
        return " ".join(captured)
    content = [line for line in lines if not _is_heading_line(line)]
    return " ".join(content[:3])


@_with_cross_encoder_lock
def build_bounded_rerank_query(
    job_title: str,
    required_skills: list[str] | None,
    raw_description: str,
    max_tokens: int = 180,
) -> str:
    """
    Constructs a concise, focused query for the Cross-Encoder.

    Guarantees:
    - Token count is strictly <= max_tokens (default 180).
    - When paired with any resume chunk (up to TARGET_MAX_TOKENS = 240, ceiling 254),
      the total sequence length never exceeds the model's 512 position embedding ceiling:
      180 + 254 + 3 = 437 <= 512.
    - Focuses on title and required skills, preventing attention dilution from noisy
      job description boilerplates (EEO, perks, company history).
    """
    title = job_title.strip().rstrip(".")
    parts: list[str] = [f"{title}."]

    clean_skills = [
        s.strip() for s in (required_skills or []) if s and isinstance(s, str) and s.strip()
    ]

    if clean_skills:
        parts.append(f"Skills: {', '.join(clean_skills)}.")
    elif raw_description and raw_description.strip():
        # Fallback when structured skills are missing: use the requirement section bodies
        excerpt = _extract_requirement_excerpt(raw_description)
        if excerpt:
            parts.append(excerpt)

    full_candidate_query = " ".join(parts).strip()

    model = get_cross_encoder()
    tok = getattr(model, "tokenizer", None)
    if tok is None:
        return full_candidate_query[:400]

    tokens = tok.encode(full_candidate_query, add_special_tokens=False)
    if len(tokens) <= max_tokens:
        return full_candidate_query

    truncated_tokens = tokens[:max_tokens]
    return str(tok.decode(truncated_tokens, skip_special_tokens=True).strip())


@_with_cross_encoder_lock
def rerank_candidates(
    job_query: str,
    candidates: list[dict[str, Any]],
    top_n: int = 20,
    top_k: int | None = None,
) -> list[dict[str, Any]]:
    """
    Reranks candidate chunks against the job description using CrossEncoder.

    Args:
        job_query: Job description context / key requirements.
        candidates: List of fused chunk dicts with 'content'.
        top_n: Number of candidates to evaluate and return (default: 20).
        top_k: Alias for top_n.

    Returns:
        List of candidate dicts enriched with 'cross_encoder_logit', 'cross_encoder_score',
        and 'rerank_score', sorted by cross_encoder_score descending.
    """
    if not candidates or not job_query.strip():
        return []

    limit = top_k if top_k is not None else top_n
    subset = candidates[:limit]
    pairs: list[list[str]] = []

    model = get_cross_encoder()
    tokenizer = getattr(model, "tokenizer", None)

    for item in subset:
        content = item.get("content", "")
        effective_query = job_query

        # Enforce sequence length protection without truncating candidate resume content
        if tokenizer is not None:
            total_tokens = len(tokenizer.encode(effective_query, content, truncation=False))
            if total_tokens > MAX_CROSS_ENCODER_SEQ_LENGTH:
                # Reserve full space for candidate chunk (up to 254 tokens + 3 specials)
                chunk_token_len = len(tokenizer.encode(content, add_special_tokens=False))
                avail_query_tokens = max(50, MAX_CROSS_ENCODER_SEQ_LENGTH - chunk_token_len - 3)
                q_tokens = tokenizer.encode(effective_query, add_special_tokens=False)[
                    :avail_query_tokens
                ]
                effective_query = tokenizer.decode(q_tokens, skip_special_tokens=True)

        pairs.append([effective_query, content])

    raw_scores = model.predict(pairs)

    reranked: list[dict[str, Any]] = []
    for item, logit in zip(subset, raw_scores, strict=True):
        entry = dict(item)
        float_logit = float(logit)
        entry["cross_encoder_logit"] = round(float_logit, 4)
        score = normalize_cross_encoder_logit(float_logit)
        entry["cross_encoder_score"] = score
        entry["rerank_score"] = score
        reranked.append(entry)

    # Sort descending by cross_encoder_score, tie-break by chunk_id
    reranked.sort(key=lambda x: (-x["cross_encoder_score"], x["chunk_id"]))

    for idx, entry in enumerate(reranked, start=1):
        entry["rerank_position"] = idx

    return reranked
