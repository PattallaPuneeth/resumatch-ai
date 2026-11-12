"""Unified Item 1 + Item 2 scoring engine (rules: docs/ITEM12_UNIFIED_RULES.md).

Pure, deterministic, exact (`fractions.Fraction`). It receives already-classified
evidence and never reads the clock, a model, or a file. One engine gives the score,
the band, the low/high range, the confidence and the per-gap fix gains.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from fractions import Fraction
from typing import Literal

from ml.scoring.curve import Curve

F = Fraction
WEIGHTS = {"sk": F(3, 5), "yr": F(1, 4), "ec": F(3, 20)}
CAP = 69
SKILL_THIN_MIN = F(3)
GATE_CREDIT = {"Met": F(1), "Partial": F(1, 2), "Not met": F(0)}
GateStatus = Literal["Met", "Partial", "Not met", "Unknown", "Confirm"]
Band = Literal["No Fit", "Potential Fit", "Good Fit"]
Tier = Literal["Firm", "Tentative", "Comparison only", "Abstain"]
BAND_ORDER = ("No Fit", "Potential Fit", "Good Fit")


def _fr(value: object) -> Fraction:
    return value if isinstance(value, Fraction) else F(str(value))


def round_half_up(value: Fraction) -> int:
    """Half-up integer rounding: (2n + d) // (2d). Scores are never negative."""
    if value < 0:
        raise ValueError("score must be nonnegative")
    return (2 * value.numerator + value.denominator) // (2 * value.denominator)


def band_for(score: int) -> Band:
    if not 0 <= score <= 100:
        raise ValueError("score must be between 0 and 100")
    return "No Fit" if score <= 39 else "Potential Fit" if score <= 69 else "Good Fit"


@dataclass(frozen=True)
class SkillUnit:
    """One JD skill. `credit` is observed credit (ladder x context x depth, in [0,1]).
    `high_credit` is the extra credit allowed only in the high scenario (siblings,
    possible matches); it is never below `credit`. `assessable=False` = Not assessable."""

    id: str
    weight: Fraction
    credit: Fraction
    high_credit: Fraction | None = None
    assessable: bool = True


@dataclass(frozen=True)
class YearsInput:
    """Years component. `required` None/0 = JD names no years (Silent).
    observed None = dates unknown (excluded from observed; low 0, high 1)."""

    required: Fraction | None
    observed: Fraction | None
    low: Fraction | None = None
    high: Fraction | None = None


@dataclass(frozen=True)
class GateUnit:
    id: str
    weight: Fraction
    status: GateStatus
    mandatory: bool


@dataclass(frozen=True)
class Flags:
    degraded_parse: bool = False
    partial_unsupported_script: bool = False
    public_sector: bool = False
    parse_failed: bool = False
    unsupported_script_majority: bool = False  # 50% or more of the text


@dataclass(frozen=True)
class Gain:
    unit_id: str
    kind: str  # "skill" | "gate"
    points: Fraction  # exact points gained if this gap were closed (or sibling accepted)


@dataclass(frozen=True)
class Scored:
    raw: Fraction
    capped: Fraction
    score: int
    components: dict[str, Fraction]  # S_i for active components
    weights: dict[str, Fraction]  # effective weight for active components
    points: dict[str, Fraction]  # contribution to raw, sums to raw
    cap_bound: bool  # cap lowered the score


@dataclass(frozen=True)
class Result:
    status: Literal["scored", "insufficient_jd_signal"]
    observed: Scored | None = None
    low: int | None = None
    high: int | None = None
    confidence: Literal["High", "Medium", "Low"] | None = None
    confidence_reasons: list[str] = field(default_factory=list)
    band: Band | None = None
    verdict_withheld: bool = False
    withheld_reason: str | None = None
    coverage: Fraction | None = None
    gate_cap: Literal["none", "observed", "low_only"] = "none"
    active_set: list[str] = field(default_factory=list)
    unknown_components: list[str] = field(default_factory=list)
    basis: str = ""
    gains: list[Gain] = field(default_factory=list)
    tier: Tier = "Abstain"
    band_range: tuple[Band, Band] | None = None  # bands of the low and high scenario scores
    curve_version: str | None = None
    curve_fitted: bool | None = None


def _score(
    skills: Sequence[SkillUnit],
    years: YearsInput | None,
    gates: Sequence[GateUnit],
    *,
    scenario: Literal["observed", "low", "high"] = "observed",
    skill_override: dict[str, Fraction] | None = None,
    curve: Curve | None = None,
) -> Scored | None:
    comps: dict[str, Fraction] = {}
    weights: dict[str, Fraction] = {}

    # --- skills ---
    rows = [s for s in skills if s.assessable]
    m_sk = sum((_fr(s.weight) for s in rows), F(0))
    if m_sk > 0:
        num = F(0)
        for s in rows:
            c = _fr(s.credit)
            if skill_override and s.id in skill_override:
                c = skill_override[s.id]
            elif scenario == "high" and s.high_credit is not None:
                c = max(c, _fr(s.high_credit))
            if not 0 <= c <= 1 or s.weight < 0:
                raise ValueError("skill credit must be in [0,1] and weight nonnegative")
            num += _fr(s.weight) * c
        comps["sk"] = curve(num / m_sk) if curve is not None else num / m_sk
        weights["sk"] = WEIGHTS["sk"] * min(F(1), m_sk / SKILL_THIN_MIN)

    # --- years ---
    if years is not None and years.required is not None and _fr(years.required) > 0:
        req = _fr(years.required)
        if scenario == "observed":
            y = years.observed
        elif scenario == "low":
            y = years.low if years.low is not None else years.observed
        else:
            y = years.high if years.high is not None else years.observed
        if years.observed is None:  # dates unknown
            y = F(0) if scenario == "low" else req if scenario == "high" else None
        if y is not None:
            if _fr(y) < 0:
                raise ValueError("years must be nonnegative")
            comps["yr"] = min(F(1), _fr(y) / req)
            weights["yr"] = WEIGHTS["yr"]

    # --- education / credentials ---
    assessed: list[tuple[Fraction, Fraction]] = []
    cap = False
    for g in gates:
        status = g.status
        if status in ("Unknown", "Confirm"):
            if scenario == "high":
                status = "Met"
            elif scenario == "low" and g.mandatory and status == "Unknown":
                cap = True  # cap only; credit is not zeroed (decision D2)
                continue
            else:
                continue
        if status not in GATE_CREDIT:
            raise ValueError(f"unsupported gate status: {status}")
        assessed.append((_fr(g.weight), GATE_CREDIT[status]))
        if g.mandatory and status in ("Partial", "Not met"):
            cap = True
    g_den = sum((w for w, _ in assessed), F(0))
    if g_den > 0:
        comps["ec"] = sum((w * c for w, c in assessed), F(0)) / g_den
        weights["ec"] = WEIGHTS["ec"]

    if not comps:
        return None
    total_w = sum(weights.values(), F(0))
    points = {k: 100 * weights[k] * comps[k] / total_w for k in comps}
    raw = sum(points.values(), F(0))
    capped = min(raw, F(CAP)) if cap else raw
    return Scored(raw, capped, round_half_up(capped), comps, weights, points, cap and raw > CAP)


def _confidence(
    *,
    coverage: Fraction,
    spread: int,
    spread_without_years: int,
    active: int,
    assessable_units: int,
    flags: Flags,
    skills_silent: bool,
    unknown_mandatory: bool,
    years_uncertain: bool,
) -> tuple[Literal["High", "Medium", "Low"], list[str]]:
    """Deterministic confidence (design D10). Low means 'show it as Tentative', not 'hide it'."""
    low_reasons: list[str] = []
    years_driven_spread = spread > 30 and spread_without_years <= 30
    if spread > 30 and not years_driven_spread:
        low_reasons.append("score range is wider than 30 points")
    if coverage < F(2, 5):
        low_reasons.append("under 40% of the job's requirements could be assessed")
    if active < 2 and assessable_units < 3:
        low_reasons.append("fewer than 3 assessable requirements and one scoring component")
    if low_reasons:
        return "Low", low_reasons
    med: list[str] = []
    if active < 2:
        med.append("only one scoring component had data")
    if years_driven_spread or (years_uncertain and spread > 10):
        med.append("the dates on the resume could not be fully read")
    if skills_silent:
        med.append("the job lists no assessable skills")
    if unknown_mandatory:
        med.append("a required licence or degree is not stated on the resume")
    if flags.degraded_parse:
        med.append("the document was only partly readable")
    if flags.partial_unsupported_script:
        med.append("part of the text is in an unsupported script")
    if spread > 10 and not years_driven_spread and not years_uncertain:
        med.append("score range is wider than 10 points")
    if coverage < F(7, 10):
        med.append("under 70% of the job's requirements could be assessed")
    if med:
        return "Medium", med
    return "High", ["clear evidence for most requirements"]


def evaluate(
    skills: Sequence[SkillUnit],
    years: YearsInput | None,
    gates: Sequence[GateUnit],
    *,
    total_units: int | None = None,
    flags: Flags = Flags(),
    curve: Curve | None = None,
) -> Result:
    """Score one resume against one JD. `total_units` = every unit the JD asked for
    (assessable or not); defaults to the units passed in. `curve` maps skill coverage to the
    skill component (design D3); None keeps the identity map used by the golden tests."""
    if flags.parse_failed or flags.unsupported_script_majority:
        why = (
            "The document could not be read."
            if flags.parse_failed
            else "Most of the text is in a language or script this version cannot assess."
        )
        return Result(
            status="insufficient_jd_signal",
            tier="Abstain",
            verdict_withheld=True,
            withheld_reason=why,
        )
    obs = _score(skills, years, gates, curve=curve)
    if obs is None:
        return Result(
            status="insufficient_jd_signal",
            tier="Abstain",
            verdict_withheld=True,
            withheld_reason="The job description has too few assessable requirements.",
        )

    low_s = _score(skills, years, gates, scenario="low", curve=curve)
    high_s = _score(skills, years, gates, scenario="high", curve=curve)
    low = min(x.score for x in (obs, low_s, high_s) if x is not None)
    high = max(x.score for x in (obs, low_s, high_s) if x is not None)

    # Spread with the years component held at its observed value: separates "dates unreadable"
    # (a reading problem) from real uncertainty about the match.
    years_uncertain = years is not None and bool(years.required) and (
        years.observed is None
        or years.low != years.observed
        or years.high != years.observed
    )
    fixed_years = None
    if years is not None and years.required and years.observed is not None:
        fixed_years = YearsInput(years.required, years.observed, years.observed, years.observed)
    low_f = _score(skills, fixed_years, gates, scenario="low", curve=curve)
    high_f = _score(skills, fixed_years, gates, scenario="high", curve=curve)
    pair_f = [x.score for x in (obs, low_f, high_f) if x is not None]
    spread_without_years = (max(pair_f) - min(pair_f)) if pair_f else high - low

    unknown_mand = any(g.mandatory and g.status == "Unknown" for g in gates)
    gate_cap: Literal["none", "observed", "low_only"] = "none"
    if obs.cap_bound:
        gate_cap = "observed"
    elif low_s is not None and low_s.cap_bound and not obs.cap_bound:
        gate_cap = "low_only"

    n_skill = sum(1 for s in skills if s.assessable)
    n_years = 1 if "yr" in obs.components else 0
    n_gate = sum(1 for g in gates if g.status not in ("Unknown", "Confirm"))
    assessable_units = n_skill + n_years + n_gate
    total = total_units if total_units is not None else len(skills) + len(gates) + (
        1 if years is not None and years.required else 0
    )
    coverage = min(F(1), F(assessable_units, total)) if total else F(0)
    conf, reasons = _confidence(
        coverage=coverage,
        spread=high - low,
        spread_without_years=spread_without_years,
        active=len(obs.components),
        assessable_units=assessable_units,
        flags=flags,
        skills_silent="sk" not in obs.components,
        unknown_mandatory=unknown_mand,
        years_uncertain=bool(years_uncertain),
    )

    # Tiers (design D9): Abstain only for hard reasons; Low confidence is shown as Tentative.
    tier: Tier = "Firm" if conf in ("High", "Medium") else "Tentative"
    withheld, why = False, None
    if flags.public_sector:
        tier, withheld = "Comparison only", True
        why = "Comparison score only; official eligibility is set by the notification terms."
    band_range = (band_for(low), band_for(high))

    # fix tips: points gained if each gap were closed (observed scenario)
    gains: list[Gain] = []
    for s in skills:
        if s.assessable and _fr(s.credit) < 1:
            target = _fr(s.high_credit) if s.high_credit is not None else F(1)
            alt = _score(skills, years, gates, skill_override={s.id: target}, curve=curve)
            if alt is not None and alt.capped > obs.capped:
                gains.append(Gain(s.id, "skill", alt.capped - obs.capped))
    for g in gates:
        if g.status in ("Partial", "Not met"):
            fixed = [replace(x, status="Met") if x.id == g.id else x for x in gates]
            alt = _score(skills, years, fixed, curve=curve)
            if alt is not None and alt.capped > obs.capped:
                gains.append(Gain(g.id, "gate", alt.capped - obs.capped))
    gains.sort(key=lambda x: (-x.points, x.unit_id))

    active = [k for k in ("sk", "yr", "ec") if k in obs.components]
    unknown = [k for k in ("yr", "ec") if k not in obs.components and k in _asked(years, gates)]
    return Result(
        status="scored",
        observed=obs,
        low=low,
        high=high,
        confidence=conf,
        confidence_reasons=reasons,
        band=None if withheld else band_for(obs.score),
        verdict_withheld=withheld,
        withheld_reason=why,
        coverage=coverage,
        gate_cap=gate_cap,
        active_set=active,
        unknown_components=unknown,
        basis="_and_".join({"sk": "skills", "yr": "years", "ec": "education"}[k] for k in active),
        gains=gains,
        tier=tier,
        band_range=band_range,
        curve_version=None if curve is None else curve.version,
        curve_fitted=None if curve is None else curve.fitted,
    )


def _asked(years: YearsInput | None, gates: Sequence[GateUnit]) -> set[str]:
    asked: set[str] = set()
    if years is not None and years.required:
        asked.add("yr")
    if gates:
        asked.add("ec")
    return asked
