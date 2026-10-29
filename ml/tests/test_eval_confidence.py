"""Bootstrap confidence intervals for the eval harness."""

from __future__ import annotations

from ml.eval.metrics import bootstrap_confidence_intervals, calculate_pairwise_ordering_accuracy


def _examples(n: int) -> list[dict[str, object]]:
    labels = ["strong", "medium", "weak"]
    # Mostly well ordered, with a few inversions, so the true value is below 1
    return [{"expected": labels[i % 3], "final_score": 90 - 30 * (i % 3) + (40 if i % 7 == 0 else 0)}
            for i in range(n)]


def test_interval_contains_the_point_estimate_and_is_ordered() -> None:
    ex = _examples(90)
    ci = bootstrap_confidence_intervals(ex, n_resamples=300)
    lo, hi = ci["pairwise_ordering_accuracy"]
    assert lo <= calculate_pairwise_ordering_accuracy(ex) <= hi and 0 <= lo < hi <= 1
    assert ci["label_accuracy"][0] <= ci["label_accuracy"][1]


def test_smaller_samples_give_wider_intervals() -> None:
    small = bootstrap_confidence_intervals(_examples(30), n_resamples=300)["pairwise_ordering_accuracy"]
    large = bootstrap_confidence_intervals(_examples(300), n_resamples=300)["pairwise_ordering_accuracy"]
    assert (small[1] - small[0]) > (large[1] - large[0])


def test_same_seed_same_interval() -> None:
    ex = _examples(60)
    assert bootstrap_confidence_intervals(ex, n_resamples=200) == bootstrap_confidence_intervals(
        ex, n_resamples=200
    )
