"""
Unit tests for ml/scoring/curves.py.
Verifies all mathematical curve primitives, edge cases, monotonicity,
saturation targets, and date interval union.
"""

from __future__ import annotations

import math
from datetime import date

import pytest

from ml.scoring.curves import (
    clamp,
    diminishing_evidence,
    exp_penalty,
    must_have_gate,
    quantification_curve,
    saturate,
    sigmoid,
    union_years,
)


class TestCurvesMath:
    def test_clamp(self) -> None:
        assert clamp(0.5, 0.0, 1.0) == 0.5
        assert clamp(-0.1, 0.0, 1.0) == 0.0
        assert clamp(1.5, 0.0, 1.0) == 1.0
        assert clamp(float("nan"), 0.0, 1.0) == 0.0

    def test_sigmoid(self) -> None:
        assert sigmoid(0.0) == 0.5
        assert sigmoid(10.0) > 0.999
        assert sigmoid(-10.0) < 0.001
        assert sigmoid(800.0) == 1.0
        assert sigmoid(-800.0) == 0.0

    def test_exp_penalty(self) -> None:
        # At zero hazard, penalty is 1.0 (no reduction)
        assert exp_penalty(0.0, 25.0) == 1.0
        assert exp_penalty(-0.05, 25.0) == 1.0
        # Decay is monotonic
        p1 = exp_penalty(0.01, 25.0)
        p2 = exp_penalty(0.05, 25.0)
        assert 0.0 < p2 < p1 < 1.0
        # Check half-life at ln(2) / k
        half_life = math.log(2.0) / 25.0
        assert pytest.approx(exp_penalty(half_life, 25.0), rel=1e-4) == 0.5

    def test_saturate(self) -> None:
        assert saturate(0.0, 0.18) == 0.0
        assert saturate(-1.0, 0.18) == 0.0
        # ~63.2% at tau
        assert pytest.approx(saturate(0.18, 0.18), rel=1e-3) == 0.6321
        # ~95% at 3*tau
        assert pytest.approx(saturate(3 * 0.18, 0.18), rel=1e-3) == 0.9502
        with pytest.raises(ValueError, match="strictly positive"):
            saturate(1.0, 0.0)

    def test_diminishing_evidence(self) -> None:
        # Empty or zero weights
        assert diminishing_evidence([]) == 0.0
        assert diminishing_evidence([0.0, 0.0]) == 0.0

        # Single evidence item with weight 1.0
        score_1 = diminishing_evidence([1.0])
        assert 0.0 < score_1 < 1.0

        # Adding repeated mentions increases score with diminishing returns
        score_2 = diminishing_evidence([1.0, 1.0])
        score_5 = diminishing_evidence([1.0] * 5)
        score_20 = diminishing_evidence([1.0] * 20)

        assert score_1 < score_2 < score_5 <= score_20 <= 1.0

        # Check that 20 identical mentions cannot blow past theoretical bound
        assert score_20 <= 1.0

    def test_quantification_curve(self) -> None:
        # At 0 quantification, score is 0
        assert quantification_curve(0.0) == 0.0
        assert quantification_curve(-0.1) == 0.0

        # At partial values (e.g. 10%, 20%)
        q_10 = quantification_curve(0.10)
        q_20 = quantification_curve(0.20)
        assert 0.40 < q_10 < 0.55
        assert 0.65 < q_20 < 0.80
        assert q_10 < q_20

        # Full credit at target knee (q* = 0.45)
        assert pytest.approx(quantification_curve(0.45), abs=1e-4) == 1.0

        # Stays 1.0 in saturation sweet spot (0.45 to 0.80)
        assert quantification_curve(0.60) == 1.0
        assert quantification_curve(0.80) == 1.0

        # Over-saturation dampening kicks in above 0.80
        q_90 = quantification_curve(0.90)
        q_100 = quantification_curve(1.00)
        assert q_90 == pytest.approx(1.0 - 0.5 * (0.90 - 0.80), abs=1e-4)
        assert q_100 == pytest.approx(1.0 - 0.5 * (1.00 - 0.80), abs=1e-4)
        assert q_100 < q_90 < 1.0

    def test_must_have_gate(self) -> None:
        # M = 0 -> strictly 0
        assert must_have_gate(0.0) == 0.0
        assert must_have_gate(-0.5) == 0.0

        # M = 1 -> strictly 1
        assert must_have_gate(1.0) == 1.0
        assert must_have_gate(1.5) == 1.0

        # M = 0.25 -> ~0.435
        assert pytest.approx(must_have_gate(0.25), abs=1e-3) == 0.435

        # M = 0.50 -> ~0.660
        assert pytest.approx(must_have_gate(0.50), abs=1e-3) == 0.660

        # M = 0.75 -> ~0.841
        assert pytest.approx(must_have_gate(0.75), abs=1e-3) == 0.841

        # Strictly monotonic over [0.0, 1.0]
        values = [must_have_gate(x / 100.0) for x in range(101)]
        for i in range(len(values) - 1):
            assert values[i] <= values[i + 1]


class TestDateIntervalUnion:
    def test_empty_or_invalid_spans(self) -> None:
        assert union_years([]) == 0.0
        # Inverted dates should be ignored
        assert union_years([(date(2022, 1, 1), date(2021, 1, 1))]) == 0.0

    def test_single_span(self) -> None:
        # Exactly 1 leap year + 1 normal year = 2 years
        span = (date(2020, 1, 1), date(2022, 1, 1))  # 731 days / 365.25 = 2.001369
        years = union_years([span])
        assert pytest.approx(years, rel=1e-2) == 2.0

    def test_disjoint_spans(self) -> None:
        # Job 1: 2018 to 2019 (~1 year)
        # Job 2: 2020 to 2021 (~1 year)
        spans = [
            (date(2018, 1, 1), date(2019, 1, 1)),
            (date(2020, 1, 1), date(2021, 1, 1)),
        ]
        years = union_years(spans)
        assert pytest.approx(years, rel=1e-2) == 2.0

    def test_overlapping_spans_deduplication(self) -> None:
        # Job 1: Full-time: Jan 2020 to Jan 2022 (2 years)
        # Job 2: Concurrent Startup Advisor: Jun 2020 to Jun 2021 (1 year, completely nested)
        spans = [
            (date(2020, 1, 1), date(2022, 1, 1)),
            (date(2020, 6, 1), date(2021, 6, 1)),
        ]
        # Sum of naive durations would be 3.0 years, but calendar interval is only 2.0 years
        years = union_years(spans)
        assert pytest.approx(years, rel=1e-2) == 2.0

    def test_partially_overlapping_spans(self) -> None:
        # Job 1: Jan 2020 to Jan 2022 (2 years)
        # Job 2: Jul 2021 to Jul 2023 (overlaps by 6 months, extends by 1.5 years)
        # Total span should be Jan 2020 to Jul 2023 = 3.5 years
        spans = [
            (date(2020, 1, 1), date(2022, 1, 1)),
            (date(2021, 7, 1), date(2023, 7, 1)),
        ]
        years = union_years(spans)
        assert pytest.approx(years, rel=1e-2) == 3.5
