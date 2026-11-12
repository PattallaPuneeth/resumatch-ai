"""
ResuMatch AI: Mathematical Curve Primitives & Evidence Discounting.
Provides deterministic, non-linear functions for ATS readability hazard penalties,
content quantification saturation, geometric evidence decay, and knockout gating.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Sequence


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    """Clamps a numeric value within [lo, hi]."""
    if math.isnan(x):
        return lo
    return max(lo, min(hi, x))


def sigmoid(x: float) -> float:
    """Standard logistic sigmoid function mapping R -> (0, 1)."""
    if x < -700:
        return 0.0
    if x > 700:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def exp_penalty(x: float, k: float) -> float:
    """
    Exponential decay penalty: 1.0 at x=0, decays toward 0.0 as x increases.
    Half-life occurs at x = ln(2) / k.
    
    Args:
        x: Hazard intensity or error ratio (e.g. garbage character ratio, interleave rate).
        k: Steepness decay constant.
    """
    if x <= 0.0:
        return 1.0
    return math.exp(-k * x)


def saturate(x: float, tau: float) -> float:
    """
    Diminishing-returns curve: 0.0 at x=0, ~0.632 at x=tau, ~0.950 at x=3*tau.
    
    Args:
        x: Input quantity (e.g. evidence count or density).
        tau: Characteristic scale parameter (tau > 0).
    """
    if tau <= 0.0:
        raise ValueError("tau parameter must be strictly positive")
    if x <= 0.0:
        return 0.0
    return 1.0 - math.exp(-x / tau)


def diminishing_evidence(
    ws: Sequence[float],
    gamma: float = 0.5,
    lam: float = 0.8,
) -> float:
    """
    Computes geometric evidence aggregation with diminishing returns.
    Mentions are sorted descending by weight and discounted geometrically by gamma^i.
    The effective weight is then scaled through a bounded saturation curve.
    
    Args:
        ws: Sequence of weights for each evidence occurrence.
        gamma: Geometric discount rate per additional occurrence (default: 0.5).
        lam: Scale factor for the exponential saturation curve (default: 0.8).
    
    Returns:
        Aggregated evidence score in [0.0, 1.0].
    """
    valid_ws = [w for w in ws if w > 0.0]
    if not valid_ws:
        return 0.0
    
    # Sort descending so highest-quality context gets full weight
    sorted_ws = sorted(valid_ws, reverse=True)
    eff = sum(w * (gamma ** i) for i, w in enumerate(sorted_ws))
    
    denom = 1.0 - math.exp(-2.0 / lam)
    if denom <= 0.0:
        return 0.0
    
    raw = (1.0 - math.exp(-eff / lam)) / denom
    return clamp(raw, 0.0, 1.0)


def quantification_curve(
    q: float,
    tau: float = 0.18,
    q_star: float = 0.45,
    over_sat_threshold: float = 0.80,
    over_sat_penalty: float = 0.5,
) -> float:
    """
    Computes the content quantification score using a saturation knee with
    mild dampening for excessive numeric clutter.
    
    - Target knee (q*): Full credit (1.0) achieved at q* (e.g. 45% bullets quantified).
    - Saturation zone: Flat 1.0 credit between q* and over_sat_threshold.
    - Clutter penalty: Linear decay if quantification exceeds over_sat_threshold.
    
    Args:
        q: Ratio of quantified bullets to total bullets (in [0.0, 1.0]).
        tau: Exponential curvature rate.
        q_star: Quantification saturation target (default: 0.45).
        over_sat_threshold: Onset threshold for numeric clutter penalty (default: 0.80).
        over_sat_penalty: Penalty rate for metrics exceeding threshold (default: 0.5).
    """
    if q <= 0.0:
        return 0.0
    if q <= q_star:
        norm_denom = 1.0 - math.exp(-q_star / tau)
        return clamp((1.0 - math.exp(-q / tau)) / norm_denom, 0.0, 1.0)
    if q <= over_sat_threshold:
        return 1.0
    # Over-saturation dampening (e.g. resume that is 90% numbers looks artificially stuffed)
    excess = q - over_sat_threshold
    return clamp(1.0 - over_sat_penalty * excess, 0.0, 1.0)


def must_have_gate(m: float, power: float = 0.60) -> float:
    """
    Continuous Must-Have Gate: G(M) = M^power.
    Strictly monotonic over [0.0, 1.0] with no flat clamping:
    - M = 0.00 -> G = 0.00 (Score is strictly 0 without core skills)
    - M = 0.25 -> G ~ 0.435
    - M = 0.50 -> G ~ 0.660
    - M = 0.75 -> G ~ 0.841
    - M = 1.00 -> G = 1.000
    
    Args:
        m: Ratio of satisfied must-have skills (in [0.0, 1.0]).
        power: Curvature power parameter (default: 0.60).
    """
    if m <= 0.0:
        return 0.0
    if m >= 1.0:
        return 1.0
    return clamp(m ** power, 0.0, 1.0)


def union_years(spans: Sequence[tuple[date, date]]) -> float:
    """
    Calculates total calendar tenure in years by merging overlapping and
    nested employment date spans (interval union).
    
    Args:
        spans: Sequence of (start_date, end_date) tuples where start_date <= end_date.
    
    Returns:
        Total deduplicated calendar tenure in years (using 365.25 days/year).
    """
    valid_spans = [
        (s, e) for s, e in spans if s is not None and e is not None and s <= e
    ]
    if not valid_spans:
        return 0.0

    # Sort spans primarily by start date ascending, secondarily by end date descending
    sorted_spans = sorted(valid_spans, key=lambda span: (span[0], -span[1].toordinal()))
    
    total_days = 0
    cur_start, cur_end = sorted_spans[0]
    
    for next_start, next_end in sorted_spans[1:]:
        if next_start <= cur_end:
            # Overlapping or contiguous interval -> extend current window
            if next_end > cur_end:
                cur_end = next_end
        else:
            # Disjoint interval -> tally previous window and start new
            total_days += (cur_end - cur_start).days
            cur_start, cur_end = next_start, next_end
            
    total_days += (cur_end - cur_start).days
    return max(0.0, total_days / 365.25)
