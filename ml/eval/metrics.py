"""
Evaluation Metrics for ResuMatch AI (Phase 3C-1).

Calculates:
- Pairwise ordering accuracy (strict strong > medium > weak ranking)
- Mean score per ground-truth label
- Label separation gaps (strong-to-medium and medium-to-weak)
- Label classification accuracy (evaluated against calibrated score thresholds)
"""

from __future__ import annotations

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


def calculate_label_accuracy(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
    strong_threshold: float = 75.0,
    weak_threshold: float = 45.0,
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


def compute_comprehensive_metrics(
    scored_examples: list[dict[str, Any]],
    score_key: str = "final_score",
    strong_threshold: float = 75.0,
    weak_threshold: float = 45.0,
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
    }
