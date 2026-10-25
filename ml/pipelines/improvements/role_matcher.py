"""
Phase 4C: ML-Ranked Role Suggestions.
Computes cosine similarity between the resume vector (mean of existing chunk vectors)
and role vectors (embedded lazily with the already-loaded SentenceTransformer model,
cached in memory).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np
from ml.pipelines.embeddings.embedder import get_embedder
from ml.pipelines.improvements.models import SuggestedRole
from ml.pipelines.matching.skill_gap import (
    _clean_text,
    _extract_all_resume_skills,
    _is_word_boundary_match,
    load_skill_aliases,
)

logger = logging.getLogger("resumatch-ml-role-matcher")

_TAXONOMY_PATH = Path(__file__).resolve().parent.parent.parent / "data" / "role_taxonomy.json"
_ROLES_DATA: list[dict[str, Any]] | None = None
_ROLE_VECTORS_CACHE: np.ndarray | None = None


def load_role_taxonomy() -> list[dict[str, Any]]:
    """Loads and caches the static role taxonomy."""
    global _ROLES_DATA
    if _ROLES_DATA is not None:
        return _ROLES_DATA

    if not _TAXONOMY_PATH.exists():
        raise FileNotFoundError(f"Role taxonomy not found at {_TAXONOMY_PATH}")

    with open(_TAXONOMY_PATH, encoding="utf-8") as f:
        _ROLES_DATA = json.load(f)

    logger.info("Loaded %d roles from role taxonomy", len(_ROLES_DATA))
    return _ROLES_DATA


def get_role_vectors() -> tuple[list[dict[str, Any]], np.ndarray]:
    """
    Returns the role taxonomy list and the normalized in-memory role embedding matrix (N, 384).
    Lazily generates embeddings once using the singleton SentenceTransformer instance.
    """
    global _ROLE_VECTORS_CACHE
    roles = load_role_taxonomy()

    if _ROLE_VECTORS_CACHE is not None:
        return roles, _ROLE_VECTORS_CACHE

    logger.info("Generating role vector embeddings for %d roles...", len(roles))
    texts = [
        f"{r['title']}: {r['description']} Core skills: {', '.join(r.get('coreSkills', []))}."
        for r in roles
    ]

    embedder = get_embedder()
    raw_vecs = embedder.encode(
        texts,
        convert_to_numpy=True,
        normalize_embeddings=True,
        batch_size=32,
    )
    _ROLE_VECTORS_CACHE = raw_vecs.astype(np.float32)
    logger.info("Cached %d role vectors in memory.", len(roles))

    return roles, _ROLE_VECTORS_CACHE


def _extract_candidate_skills(
    skills_data: Any | None,
    raw_text: str,
) -> set[str]:
    """
    Extracts all canonical skill aliases present in either structured skills data
    or raw resume text.
    """
    canonical_skills, raw_skills = _extract_all_resume_skills(skills_data)
    aliases = load_skill_aliases()
    lower_raw = raw_text.lower()

    # Also search for canonical skills in rawText using boundary matching
    for alias_raw, canonical in aliases.items():
        if _is_word_boundary_match(alias_raw, lower_raw):
            canonical_skills.add(canonical)

    return canonical_skills


def suggest_roles(
    resume_vector: np.ndarray | list[float],
    skills_data: Any | None,
    raw_text: str,
    top_k: int = 5,
) -> list[SuggestedRole]:
    """
    Ranks roles by cosine similarity against the resume vector and returns top_k roles
    with matched skills and missing core skills.
    """
    roles, role_vecs = get_role_vectors()
    if len(roles) == 0:
        return []

    r_vec = np.asarray(resume_vector, dtype=np.float32)
    norm = np.linalg.norm(r_vec)
    if norm > 1e-8:
        r_vec = r_vec / norm
    else:
        # Zero vector fallback: return top roles by default order with 0 similarity
        r_vec = np.zeros(role_vecs.shape[1], dtype=np.float32)

    # Cosine similarities (role_vecs are already unit normalized)
    similarities = np.dot(role_vecs, r_vec)

    # Top-K indices sorted descending
    top_indices = np.argsort(similarities)[::-1][:top_k]

    candidate_skills = _extract_candidate_skills(skills_data, raw_text)
    aliases = load_skill_aliases()

    results: list[SuggestedRole] = []
    for idx in top_indices:
        role = roles[idx]
        raw_sim = float(similarities[idx])
        # Scale cosine [-1, 1] to [0, 1] for ML similarity score
        similarity_score = float(round(max(0.0, min(1.0, (raw_sim + 1.0) / 2.0)), 4))

        core_skills = role.get("coreSkills", [])
        matched: list[str] = []
        missing: list[str] = []

        for skill in core_skills:
            c_norm = aliases.get(_clean_text(skill), _clean_text(skill))
            in_cand = c_norm in candidate_skills
            in_text = _is_word_boundary_match(skill.lower(), raw_text.lower())
            if in_cand or in_text:
                matched.append(skill)
            else:
                missing.append(skill)

        results.append(
            SuggestedRole(
                title=role["title"],
                similarityScore=similarity_score,
                matchedSkills=matched,
                missingSkills=missing,
            )
        )

    return results
