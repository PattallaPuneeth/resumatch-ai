"""
Evaluation Metrics for ResuMatch AI (Phase 3C-1).

Calculates:
- Pairwise ordering accuracy (strict strong > medium > weak ranking)
- Mean score per ground-truth label
- Label separation gaps (strong-to-medium and medium-to-weak)
- Label classification accuracy (evaluated against calibrated score thresholds)
"""

from __future__ import annotations

import math
from typing import Any

LABEL_RANK_ORDER = {
    "strong": 3,
    "medium": 2,
    "weak": 1,
}


def calculate_pairwise_ordering_accuracy(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
) -> float:
    """
    Evaluates pairwise ranking consistency against ground truth labels.

    For every pair of examples (A, B) where Label(A) > Label(B):
    - If Score(A) > Score(B): 1.0 (correct ordering)
    - If Score(A) == Score(B): 0.5 (tie)
    - If Score(A) < Score(B): 0.0 (inversion)

    Returns:
        float: Fraction of pairs correctly ordered (0.0 to 1.0).
               Returns 1.0 if no comparable pairs exist.
    """
    total_comparisons = 0
    correct_points = 0.0

    n = len(scored_examples)
    for i in range(n):
        for j in range(i + 1, n):
            ex_a = scored_examples[i]
            ex_b = scored_examples[j]

            rank_a = LABEL_RANK_ORDER.get(ex_a.get("expected", "").lower(), 0)
            rank_b = LABEL_RANK_ORDER.get(ex_b.get("expected", "").lower(), 0)

            if rank_a == rank_b:
                continue

            # Ensure higher expected label is A
            if rank_a < rank_b:
                ex_a, ex_b = ex_b, ex_a

            total_comparisons += 1
            score_a = float(ex_a.get(score_key, 0.0))
            score_b = float(ex_b.get(score_key, 0.0))

            if score_a > score_b:
                correct_points += 1.0
            elif score_a == score_b:
                correct_points += 0.5

    if total_comparisons == 0:
        return 1.0

    return round(correct_points / total_comparisons, 4)


def calculate_mean_scores_per_label(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
) -> dict[str, float]:
    """
    Computes average score for each ground truth label (strong, medium, weak).
    """
    buckets: dict[str, list[float]] = {"strong": [], "medium": [], "weak": []}

    for ex in scored_examples:
        lbl = ex.get("expected", "").lower()
        if lbl in buckets:
            buckets[lbl].append(float(ex.get(score_key, 0.0)))

    means: dict[str, float] = {}
    for lbl, scores in buckets.items():
        means[lbl] = round(sum(scores) / len(scores), 2) if scores else 0.0

    return means


def calculate_label_gaps(means: dict[str, float]) -> dict[str, float]:
    """
    Computes separation margins between adjacent labels:
    - strong_to_medium: mean(strong) - mean(medium)
    - medium_to_weak: mean(medium) - mean(weak)
    - strong_to_weak: mean(strong) - mean(weak)
    """
    strong = means.get("strong", 0.0)
    medium = means.get("medium", 0.0)
    weak = means.get("weak", 0.0)

    return {
        "strong_to_medium": round(strong - medium, 2),
        "medium_to_weak": round(medium - weak, 2),
        "strong_to_weak": round(strong - weak, 2),
    }


# Canonical score threshold boundaries for discrete band classification
# Single source of truth for evaluation classification:
# - Strong: score >= DEFAULT_STRONG_THRESHOLD (75.0)
# - Medium: DEFAULT_WEAK_THRESHOLD <= score < DEFAULT_STRONG_THRESHOLD [45.0, 75.0)
# - Weak: score < DEFAULT_WEAK_THRESHOLD (45.0)
DEFAULT_STRONG_THRESHOLD: float = 75.0
DEFAULT_WEAK_THRESHOLD: float = 45.0


def calculate_label_accuracy(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
    strong_threshold: float = DEFAULT_STRONG_THRESHOLD,
    weak_threshold: float = DEFAULT_WEAK_THRESHOLD,
) -> float:
    """
    Computes label classification accuracy based on score thresholds:
    - strong: score >= strong_threshold
    - medium: weak_threshold <= score < strong_threshold
    - weak: score < weak_threshold
    """
    if not scored_examples:
        return 0.0

    correct = 0
    for ex in scored_examples:
        expected = ex.get("expected", "").lower()
        score = float(ex.get(score_key, 0.0))

        if score >= strong_threshold:
            pred = "strong"
        elif score >= weak_threshold:
            pred = "medium"
        else:
            pred = "weak"

        if pred == expected:
            correct += 1

    return round(correct / len(scored_examples), 4)


GRADED_RELEVANCE = {"strong": 2, "medium": 1, "weak": 0}


def calculate_ranking_metrics(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
    group_key: str = "job",
    ks: tuple[int, ...] = (1, 3, 5),
) -> dict[str, float]:
    """
    Retrieval-style metrics, treating each `group_key` value as a query and its labeled
    pairs as the candidates (group_key="job": rank resumes for a job; "resume": rank jobs
    for a resume, as job suggestions do).

    Relevant = 'strong'. NDCG uses graded gains (strong=2, medium=1, weak=0).
    Ties are broken pessimistically (lower label first) so equal scores never look good.
    Queries without any strong candidate are skipped.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for ex in scored_examples:
        groups.setdefault(str(ex.get(group_key, "")), []).append(ex)

    sums: dict[str, float] = {}
    n_queries = 0
    for items in groups.values():
        rels_unsorted = [GRADED_RELEVANCE.get(str(i.get("expected", "")).lower(), 0) for i in items]
        if 2 not in rels_unsorted:
            continue
        n_queries += 1
        ranked = sorted(
            items,
            key=lambda x: (
                -float(x.get(score_key, 0.0)),
                GRADED_RELEVANCE.get(str(x.get("expected", "")).lower(), 0),
            ),
        )
        rels = [GRADED_RELEVANCE.get(str(i.get("expected", "")).lower(), 0) for i in ranked]
        n_relevant = sum(1 for r in rels if r == 2)
        first_hit = next(idx for idx, r in enumerate(rels) if r == 2)
        sums["mrr"] = sums.get("mrr", 0.0) + 1.0 / (first_hit + 1)
        ideal = sorted(rels, reverse=True)
        for k in ks:
            top = rels[:k]
            hits = sum(1 for r in top if r == 2)
            dcg = sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(top))
            idcg = sum((2**r - 1) / math.log2(i + 2) for i, r in enumerate(ideal[:k]))
            sums[f"precision@{k}"] = sums.get(f"precision@{k}", 0.0) + hits / k
            sums[f"recall@{k}"] = sums.get(f"recall@{k}", 0.0) + hits / n_relevant
            sums[f"ndcg@{k}"] = sums.get(f"ndcg@{k}", 0.0) + (dcg / idcg if idcg else 0.0)

    if n_queries == 0:
        return {"n_queries": 0.0}
    out = {name: round(total / n_queries, 4) for name, total in sums.items()}
    out["n_queries"] = float(n_queries)
    return out


def compute_comprehensive_metrics(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
    strong_threshold: float = DEFAULT_STRONG_THRESHOLD,
    weak_threshold: float = DEFAULT_WEAK_THRESHOLD,
) -> dict[str, Any]:
    """Computes all evaluation metrics for a set of scored examples."""
    means = calculate_mean_scores_per_label(scored_examples, score_key=score_key)
    gaps = calculate_label_gaps(means)
    ordering_acc = calculate_pairwise_ordering_accuracy(scored_examples, score_key=score_key)
    label_acc = calculate_label_accuracy(
        scored_examples,
        score_key=score_key,
        strong_threshold=strong_threshold,
        weak_threshold=weak_threshold,
    )

    return {
        "label_accuracy": label_acc,
        "pairwise_ordering_accuracy": ordering_acc,
        "mean_scores": means,
        "label_gaps": gaps,
        "sample_count": len(scored_examples),
        "ranking_by_job": calculate_ranking_metrics(scored_examples, score_key, "job"),
        "ranking_by_resume": calculate_ranking_metrics(scored_examples, score_key, "resume"),
    }
