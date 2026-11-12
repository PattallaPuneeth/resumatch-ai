"""Pure metric functions for the Item 1/2 evaluation (no resume text, no engine imports)."""

from __future__ import annotations

import hashlib
import random
from collections import Counter
from collections.abc import Sequence

BANDS = ("No Fit", "Potential Fit", "Good Fit")
LABEL_MAP = {
    "no fit": 0, "weak": 0, "potential fit": 1, "medium": 1, "good fit": 2, "strong": 2,
}


def label_to_int(label: str) -> int:
    key = str(label).strip().lower()
    if key not in LABEL_MAP:
        raise ValueError(f"unknown label {label!r}; use No Fit / Potential Fit / Good Fit")
    return LABEL_MAP[key]


def band_to_int(band: str | None) -> int | None:
    return None if band is None else BANDS.index(band)


def assign_split(job_key: str, test_fraction: float = 0.4, salt: str = "item12-v1") -> str:
    """Deterministic split by job so no job (and its wording) sits in both sets."""
    h = int(hashlib.sha256((salt + job_key).encode()).hexdigest(), 16) % 10_000
    return "test" if h < test_fraction * 10_000 else "tune"


def assign_splits(
    job_keys: Sequence[str], test_fraction: float = 0.4, salt: str = "item12-v1"
) -> list[str]:
    """Split pairs by job so that about `test_fraction` of the PAIRS land in test, even for small
    sets. Jobs are ordered by a stable hash (label-blind) and moved to test until the target is
    reached; no job is ever in both splits. Both splits are non-empty when there are 2+ jobs."""
    counts = Counter(job_keys)
    order = sorted(counts, key=lambda j: hashlib.sha256((salt + j).encode()).hexdigest())
    target = test_fraction * len(job_keys)
    test_jobs: set[str] = set()
    taken = 0
    for j in order:
        if taken >= target and test_jobs:
            break
        if len(test_jobs) == len(order) - 1:
            break  # keep at least one job for tune
        test_jobs.add(j)
        taken += counts[j]
    return ["test" if j in test_jobs else "tune" for j in job_keys]


def bootstrap_ci(
    flags: Sequence[bool], n: int = 1000, seed: int = 0, level: float = 0.95
) -> tuple[float, float]:
    if not flags:
        return (0.0, 0.0)
    rng = random.Random(seed)
    k = len(flags)
    stats = sorted(sum(flags[rng.randrange(k)] for _ in range(k)) / k for _ in range(n))
    lo = stats[int((1 - level) / 2 * n)]
    hi = stats[min(n - 1, int((1 + level) / 2 * n))]
    return (lo, hi)


def summarize(
    truth: Sequence[int],
    pred: Sequence[int | None],
    ranges: Sequence[tuple[int, int] | None] | None = None,
    tiers: Sequence[str] | None = None,
    confidence: Sequence[str | None] | None = None,
) -> dict:
    """`pred` is the observed band as an int, or None when the engine gave no verdict."""
    n = len(truth)
    if n == 0 or n != len(pred):
        raise ValueError("truth and pred must be the same non-zero length")
    answered = [(t, p) for t, p in zip(truth, pred, strict=True) if p is not None]
    correct = sum(1 for t, p in answered if t == p)
    wrong = len(answered) - correct
    confusion = [[0, 0, 0, 0] for _ in range(3)]  # rows truth; cols No/Pot/Good/none
    for t, p in zip(truth, pred, strict=True):
        confusion[t][3 if p is None else p] += 1
    flags = [p is not None and t == p for t, p in zip(truth, pred, strict=True)]
    out: dict = {
        "n": n,
        "correct": correct,
        "wrong": wrong,
        "no_verdict": n - len(answered),
        "accuracy": correct / n,
        "accuracy_ci95": bootstrap_ci(flags),
        "accuracy_when_answered": correct / len(answered) if answered else None,
        "within_one_band": sum(1 for t, p in answered if abs(t - p) <= 1) / n,
        "opposite_extreme_errors": sum(1 for t, p in answered if abs(t - p) == 2) / n,
        "binary_fit_vs_not": (
            sum(1 for t, p in answered if (t > 0) == (p > 0)) / n if answered else None
        ),
        "confusion_rows_truth_cols_no_pot_good_none": confusion,
        "majority_baseline": max(Counter(truth).values()) / n,
    }
    if ranges is not None:
        hits = [r is not None and r[0] <= t <= r[1] for t, r in zip(truth, ranges, strict=True)]
        out["label_inside_band_range"] = sum(hits) / n
    for name, groups in (("by_tier", tiers), ("by_confidence", confidence)):
        if groups is None:
            continue
        table: dict[str, dict[str, int]] = {}
        for t, p, g in zip(truth, pred, groups, strict=True):
            row = table.setdefault(str(g), {"n": 0, "correct": 0, "wrong": 0, "no_verdict": 0})
            row["n"] += 1
            if p is None:
                row["no_verdict"] += 1
            elif t == p:
                row["correct"] += 1
            else:
                row["wrong"] += 1
        out[name] = table
    return out


def passes_gate(summary: dict) -> dict[str, bool]:
    """The acceptance gate in docs/ITEM12_ACCURACY_DESIGN.md section 2."""
    return {
        "accuracy >= 58% and lower CI >= 52%": summary["accuracy"] >= 0.58
        and summary["accuracy_ci95"][0] >= 0.52,
        "binary >= 75%": (summary["binary_fit_vs_not"] or 0) >= 0.75,
        "within one band >= 92%": summary["within_one_band"] >= 0.92,
        "opposite-extreme errors <= 8%": summary["opposite_extreme_errors"] <= 0.08,
        "no-verdict <= 5%": summary["no_verdict"] / summary["n"] <= 0.05,
    }
