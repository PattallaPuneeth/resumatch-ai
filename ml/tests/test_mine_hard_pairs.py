"""
Tests for the hard-pair selection logic in ml/eval/mine_hard_pairs.py (no models, no DB).
"""

from __future__ import annotations

from ml.eval.mine_hard_pairs import (
    EXTENDED_FIELD,
    Candidate,
    band_for_score,
    compute_hardness,
    select_hard_pairs,
)

FIELDS = ["ACCOUNTANT", "Apparel", "Banking", "Finance", "Research Assistant", "TEACHER"]


def _cand(
    resume: str,
    score: float,
    label: str = "weak",
    field: str = "ACCOUNTANT",
    job: str = "job_x.txt",
) -> Candidate:
    dataset = "extended" if field == EXTENDED_FIELD else "kaggle_domain"
    return Candidate(dataset, "test", field, resume, job, label, score)


def test_band_for_score_matches_metric_thresholds() -> None:
    assert band_for_score(44.99) == "weak"
    assert band_for_score(45.0) == "medium"
    assert band_for_score(74.99) == "medium"
    assert band_for_score(75.0) == "strong"


def test_hardness_components() -> None:
    at_edge = compute_hardness(_cand("a", 45.0, "medium"))
    assert at_edge.near_edge and at_edge.edge_distance == 0.0
    assert at_edge.band_disagreement == 0 and at_edge.score == 1.0

    outside_window = compute_hardness(_cand("b", 30.0, "weak"))
    assert not outside_window.near_edge and outside_window.score == 0.0

    # Model strong, auto label weak: two bands apart, 3 points above the 75 edge.
    contradiction = compute_hardness(_cand("c", 78.0, "weak"))
    assert contradiction.band_disagreement == 2
    assert contradiction.score == round(2 + (1 - 3 / 7), 6)


def test_known_noise_pair_ranks_first_even_when_far_from_edges() -> None:
    noise = _cand("R0118.txt", 60.0, "weak", job="job_accountant.txt")
    h = compute_hardness(noise)
    assert h.known_noise and h.score == 4.0

    pool = [noise] + [_cand(f"r{i}", 75.0 + i * 0.1, "weak") for i in range(10)]
    picked = select_hard_pairs(pool, n=3, extended_quota=0)
    assert "R0118.txt" in {c.resume for c, _ in picked}


def test_selection_balances_fields_and_respects_extended_quota() -> None:
    pool = [_cand(f"{f}_{i}", 45.0 + i, "medium", field=f) for f in FIELDS for i in range(20)] + [
        _cand(f"ext_{i}", 75.0 - i, "strong", field=EXTENDED_FIELD) for i in range(20)
    ]
    picked = select_hard_pairs(pool, n=50, extended_quota=8)

    assert len(picked) == 50
    counts: dict[str, int] = {}
    for c, _ in picked:
        counts[c.field] = counts.get(c.field, 0) + 1
    assert counts[EXTENDED_FIELD] == 8
    assert all(counts[f] == 7 for f in FIELDS)
    # Within a field the closest-to-edge pairs win.
    acct = sorted(c.model_score for c, _ in picked if c.field == "ACCOUNTANT")
    assert acct == [45.0 + i for i in range(7)]


def test_short_field_slots_are_refilled_from_other_fields() -> None:
    pool = [_cand("only_one", 46.0, field="Banking")] + [
        _cand(f"acc_{i}", 45.0 + i * 0.5, field="ACCOUNTANT") for i in range(30)
    ]
    picked = select_hard_pairs(pool, n=10, extended_quota=8)
    assert len(picked) == 10
    assert sum(c.field == "Banking" for c, _ in picked) == 1


def test_selection_is_deterministic_regardless_of_input_order() -> None:
    pool = [_cand(f"r{i:02d}", 50.0, "weak", field=FIELDS[i % 6]) for i in range(30)]
    first = [c.pair_id for c, _ in select_hard_pairs(pool, n=12, extended_quota=0)]
    second = [c.pair_id for c, _ in select_hard_pairs(reversed(pool), n=12, extended_quota=0)]
    assert first == second
