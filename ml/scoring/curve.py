"""Monotone coverage-to-score curve (design D3, docs/ITEM12_ACCURACY_DESIGN.md).

Raw requirement coverage on real postings sits in a narrow low range. The curve maps it to the
0-1 skill component so the fixed 40/70 bands line up with real labels. It is a piecewise-linear,
non-decreasing function with at most six knots, stored in a versioned JSON file, with exact
`Fraction` arithmetic. Fitting uses pooled-adjacent-violators (isotonic regression), no libraries.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

F = Fraction
MAX_KNOTS = 6
MAX_SLOPE = F(6)
DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "coverage_curve_v1.json"
BAND_TARGET = {0: F(1, 5), 1: F(11, 20), 2: F(17, 20)}  # weak/medium/strong -> score targets


@dataclass(frozen=True)
class Curve:
    version: str
    fitted: bool
    knots: tuple[tuple[Fraction, Fraction], ...]

    def __call__(self, x: Fraction) -> Fraction:
        x = min(F(1), max(F(0), x))
        pts = self.knots
        for (x0, y0), (x1, y1) in zip(pts, pts[1:], strict=False):
            if x <= x1:
                if x1 == x0:
                    return y1
                return y0 + (y1 - y0) * (x - x0) / (x1 - x0)
        return pts[-1][1]


def validate(knots: Sequence[tuple[Fraction, Fraction]]) -> None:
    if not 2 <= len(knots) <= MAX_KNOTS:
        raise ValueError(f"a curve needs 2..{MAX_KNOTS} knots")
    if knots[0] != (F(0), F(0)) or knots[-1] != (F(1), F(1)):
        raise ValueError("curve must start at (0,0) and end at (1,1)")
    for (x0, y0), (x1, y1) in zip(knots, knots[1:], strict=False):
        if x1 <= x0:
            raise ValueError("knot x values must strictly increase")
        if y1 < y0:
            raise ValueError("curve must be non-decreasing")
        if (y1 - y0) / (x1 - x0) > MAX_SLOPE:
            raise ValueError("segment is steeper than the allowed maximum slope")
    if any(not (0 <= y <= 1) for _, y in knots):
        raise ValueError("knot y values must lie in [0,1]")


def from_dict(data: dict) -> Curve:
    knots = tuple((F(str(x)), F(str(y))) for x, y in data["knots"])
    validate(knots)
    return Curve(str(data["version"]), bool(data["fitted"]), knots)


def load(path: Path | None = None) -> Curve:
    return from_dict(json.loads((path or DEFAULT_PATH).read_text(encoding="utf-8")))


def isotonic(values: Sequence[float]) -> list[float]:
    """Pool-adjacent-violators: the non-decreasing sequence closest (least squares) to values."""
    blocks: list[list[float]] = []  # [sum, count]
    for v in values:
        blocks.append([float(v), 1.0])
        while len(blocks) > 1 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1]:
            s, n = blocks.pop()
            blocks[-1][0] += s
            blocks[-1][1] += n
    out: list[float] = []
    for s, n in blocks:
        out.extend([s / n] * int(n))
    return out


def fit(pairs: Sequence[tuple[float, int]], *, version: str = "fit") -> Curve:
    """Fit a curve from (coverage, label) pairs, label 0/1/2 = weak/medium/strong.
    Needs at least 30 pairs; the caller must pass tune data only."""
    if len(pairs) < 30:
        raise ValueError("at least 30 labeled pairs are needed to fit a curve")
    data = sorted((min(1.0, max(0.0, c)), float(BAND_TARGET[lab])) for c, lab in pairs)
    xs = [c for c, _ in data]
    ys = isotonic([v for _, v in data])
    qs = [0.1, 0.3, 0.5, 0.7, 0.9]
    knots: list[tuple[Fraction, Fraction]] = [(F(0), F(0))]
    for q in qs:
        i = min(len(xs) - 1, int(q * len(xs)))
        x = F(round(xs[i], 3)).limit_denominator(1000)
        y = F(round(ys[i], 3)).limit_denominator(1000)
        if x <= knots[-1][0] or x >= 1:
            continue
        y = max(y, knots[-1][1])
        y = min(y, knots[-1][1] + MAX_SLOPE * (x - knots[-1][0]))  # slope cap
        knots.append((x, y))
    knots = knots[: MAX_KNOTS - 1] + [(F(1), F(1))]
    # last segment must respect the slope cap too: raise the last interior knot if needed
    while len(knots) > 2 and (F(1) - knots[-2][1]) / (F(1) - knots[-2][0]) > MAX_SLOPE:
        knots.pop(-2)
    validate(knots)
    return Curve(version, True, tuple(knots))


def to_dict(curve: Curve) -> dict:
    return {
        "version": curve.version,
        "fitted": curve.fitted,
        "knots": [[str(x), str(y)] for x, y in curve.knots],
    }
