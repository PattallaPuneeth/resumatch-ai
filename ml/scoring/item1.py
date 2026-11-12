"""Item 1 deterministic resume-to-job score.
Implements the scoring arithmetic in the owner's latest ResuMatch AI reference scorer.
It accepts already-classified evidence; it does not parse resumes/JDs or assign statuses.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import ROUND_FLOOR, Decimal
from typing import Literal

D = Decimal
GateStatus = Literal["Met", "Partial", "Not met", "Unknown", "Confirm"]
Override = Literal["Met", "Not met"]
WEIGHTS = {"sk": D("0.60"), "yr": D("0.25"), "ec": D("0.15")}
CAP = D("69")
CREDIT = {"Met": D(1), "Partial": D("0.5"), "Not met": D(0)}


@dataclass(frozen=True)
class ScoreResult:
    raw: Decimal
    capped: Decimal
    score: int
    components: dict[str, Decimal]
    capped_by_mandatory_gate: bool


def round_half_up_nonnegative(value: Decimal) -> int:
    """Matches the reference scorer's floor(x + 0.5) for nonnegative scores."""
    if value < 0:
        raise ValueError("score must be nonnegative")
    return int((value + D("0.5")).to_integral_value(rounding=ROUND_FLOOR))


def calculate_score(
    skills: Sequence[tuple[object, object]],
    years: tuple[object, object] | None,
    gates: Sequence[tuple[object, GateStatus, bool]],
    override: Override | None = None,
) -> ScoreResult | None:
    """Calculate an observed score or hypothetical gate scenario.
    Skills contain (unit_weight, credit); years are (candidate_years, required_years).
    Unknown/Confirm gates are excluded unless override requests a scenario.
    """
    components: dict[str, Decimal] = {}
    if skills:
        rows = [(D(str(w)), D(str(c))) for w, c in skills]
        denom = sum((w for w, _ in rows), D(0))
        if denom <= 0 or any(w < 0 or c < 0 or c > 1 for w, c in rows):
            raise ValueError(
                "skill weights must be nonnegative, with positive total; credits in [0, 1]"
            )
        components["sk"] = sum((w * c for w, c in rows), D(0)) / denom
    if years is not None:
        y, r = D(str(years[0])), D(str(years[1]))
        if y < 0 or r < 0:
            raise ValueError("candidate years and required years must be nonnegative")
        if r > 0:
            components["yr"] = min(D(1), y / r)
    rows_g: list[tuple[Decimal, GateStatus, bool]] = []
    for weight, status, mandatory in gates:
        if status not in {"Met", "Partial", "Not met", "Unknown", "Confirm"}:
            raise ValueError(f"unsupported gate status: {status}")
        if override is not None and status in {"Unknown", "Confirm"}:
            status = override
        rows_g.append((D(str(weight)), status, mandatory))
    assessed = [(w, s, m) for w, s, m in rows_g if s in CREDIT]
    if assessed:
        denom = sum((w for w, _, _ in assessed), D(0))
        if denom <= 0 or any(w < 0 for w, _, _ in assessed):
            raise ValueError("assessed gate weights must be nonnegative with positive total")
        components["ec"] = sum((w * CREDIT[s] for w, s, _ in assessed), D(0)) / denom
    if not components:
        return None
    denom = sum((WEIGHTS[k] for k in components), D(0))
    raw = D(100) * sum((WEIGHTS[k] * v for k, v in components.items()), D(0)) / denom
    cap_applies = any(m and s in {"Not met", "Partial"} for _, s, m in assessed)
    capped = min(raw, CAP) if cap_applies else raw
    return ScoreResult(
        raw, capped, round_half_up_nonnegative(capped), components, cap_applies and raw > CAP
    )


def conditional_range(skills, years, gates) -> tuple[int, int] | None:
    """Return low/high scores when any gate is unresolved, otherwise None."""
    if not any(s in {"Unknown", "Confirm"} for _, s, _ in gates):
        return None
    low = calculate_score(skills, years, gates, "Not met")
    high = calculate_score(skills, years, gates, "Met")
    return None if low is None or high is None else (low.score, high.score)


def verdict(score: int) -> str:
    """Map a rounded score to the Item 1 candidate-guidance band."""
    if not 0 <= score <= 100:
        raise ValueError("score must be between 0 and 100")
    if score <= 39:
        return "No Fit"
    if score <= 69:
        return "Potential Fit"
    return "Good Fit"


# Alias expansion is intentionally limited to rows carrying primary-source notes in
# ml/data/item1_it_aliases.json. The broad legacy taxonomy is not imported here.
def load_verified_alias_map() -> dict[str, frozenset[str]]:
    """Load canonical skills and only their explicitly reviewed aliases."""
    import json
    from pathlib import Path

    data_path = Path(__file__).resolve().parents[1] / "data" / "item1_it_aliases.json"
    with data_path.open(encoding="utf-8") as handle:
        data = json.load(handle)
    result: dict[str, frozenset[str]] = {}
    for row in data["rows"]:
        canonical = str(row["canonical"]).strip()
        terms = frozenset(
            term.strip().casefold() for term in [canonical, *row["aliases"]] if term.strip()
        )
        result[canonical.casefold()] = terms
    return result


def find_direct_skill_evidence(requirement: str, resume_text: str) -> tuple[str, int, int] | None:
    """Return the earliest exact/verified-alias resume span for a requirement.

    Unknown requirement names can still receive direct credit on an exact literal hit;
    this helper never invents semantic equivalence.
    """
    import re

    wanted = requirement.strip().casefold()
    if not wanted or not resume_text:
        return None
    alias_map = load_verified_alias_map()
    terms = next(
        (
            values
            for canonical, values in alias_map.items()
            if wanted == canonical or wanted in values
        ),
        frozenset({wanted}),
    )
    matches: list[tuple[int, str, int]] = []
    for term in terms:
        pattern = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(term) + r"(?![A-Za-z0-9_])", re.I)
        match = pattern.search(resume_text)
        if match:
            matches.append((match.start(), match.group(0), match.end()))
    if not matches:
        return None
    start, exact_text, end = min(matches, key=lambda match: match[0])
    return exact_text, start, end
