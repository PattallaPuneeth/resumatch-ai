"""Unified Item 1 + 2 pipeline, v3.1 (docs/ITEM12_ACCURACY_DESIGN.md).

Requirement units from the job description's own text, IDF-weighted coverage with verbatim
evidence spans, a versioned coverage-to-score curve, tiers instead of withholding. Deterministic;
the only clock input is `as_of`.
"""

from __future__ import annotations

import re
import unicodedata
from datetime import date
from fractions import Fraction as F
from functools import lru_cache
from typing import Any

from ml.scoring import curve as curve_mod
from ml.scoring import llm_match
from ml.scoring import roles as roles_mod
from ml.scoring import units as U
from ml.scoring.engine import Flags, GateUnit, SkillUnit, YearsInput, evaluate
from ml.scoring.item1_assessment import _CONFIRM_ONLY, _PUBLIC_SECTOR
from ml.scoring.item1_years import assess_years, jd_title_text
from ml.scoring.pipeline import _alias_regex, _education_hits, _jd_gates, _registry

VERSION = "unified-3.1"
_LEVELS = [
    ("intern", 0), ("junior", 0), ("entry", 0), ("graduate", 0), ("associate", 1), ("mid", 1),
    ("senior", 2), ("sr", 2), ("lead", 3), ("principal", 3), ("staff", 3), ("manager", 3),
    ("director", 4), ("head", 4), ("vp", 4),
]
_LEVEL_NAME = {0: "junior", 1: "mid-level", 2: "senior", 3: "lead or manager", 4: "director or above"}


@lru_cache(maxsize=1)
def _curve() -> curve_mod.Curve:
    return curve_mod.load()


def unsupported_fraction(text: str) -> float:
    """Share of letters outside the Latin script (this version assesses Latin-script text)."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    other = sum(1 for c in letters if not unicodedata.name(c, "").startswith("LATIN"))
    return other / len(letters)


def _level(text: str) -> int | None:
    words = re.findall(r"[a-z]+", text.lower())
    hits = [lv for w in words for k, lv in _LEVELS if w == k]
    return max(hits) if hits else None


def _is_gate_line(text: str) -> bool:
    """Degree and licence lines are scored as gates, so they are not also skill units."""
    if _education_hits(text):
        return True
    return any(
        _alias_regex(a["text"], len(a["text"]) <= 3).search(text)
        for entry in _registry()
        for a in entry["aliases"]
    )


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_#]+", " ", text)).strip(" -:")


def _tip(result: U.UnitResult, idf: U.IdfTable) -> str:
    """Plain, deterministic advice for one requirement the resume only partly shows."""
    requirement = _clean(result.unit.text)[:110]
    skill_like = sorted(
        (t for t in result.missing if " " not in t and idf.idf(t) >= U.SKILL_LIKE_IDF),
        key=lambda t: -idf.idf(t),
    )
    others = sorted((t for t in result.missing if " " not in t), key=lambda t: -idf.idf(t))
    words = [w.replace("_", " ") for w in (skill_like or others)[:4]]
    list_only = bool(result.hits) and all(h.context == "skills_list" for h in result.hits)
    if result.credit > 0 and list_only and not words:
        return (f"\"{requirement}\" appears only in a skills list. Show it in a job or project "
                "bullet with what you did and the result; a list alone earns less credit.")
    if words:
        shown = ", ".join(words)
        return (f"The job asks for: \"{requirement}\". Your resume does not show: {shown}. "
                "If you have this experience, add a bullet that names it and what you achieved.")
    return (f"The job asks for: \"{requirement}\". If you have this experience, make it clearer in "
            "a bullet that names it and the result.")


def _status(r: U.UnitResult) -> str:
    if r.credit >= F(7, 10):
        return "Met"
    if r.credit > 0:
        return "Partial"
    return "Not evidenced"


def assess_pair(
    resume_text: str,
    jd_text: str,
    *,
    as_of: date | None = None,
    parse_failed: bool = False,
    curve: curve_mod.Curve | None = None,
    matcher: llm_match.Matcher | None = None,
) -> dict[str, Any]:
    as_of = as_of or date.today()
    resume_text, jd_text = resume_text or "", jd_text or ""
    idf = U.load_idf()
    seg = U.segment(jd_text, idf)
    index = U.index_resume(resume_text)
    skill_lines = tuple(u for u in seg.units if not _is_gate_line(u.text))
    results = U.score_units(skill_lines, index, idf)
    extraction, matcher_note = "deterministic", None
    if matcher is not None and results:
        unmet = tuple(r.unit for r in results if r.credit < llm_match.UNMET_BELOW)
        try:
            found = matcher(unmet, index)
            if found:
                results = llm_match.apply_matches(results, found)
                extraction = "deterministic+llm-match"
        except Exception as exc:  # noqa: BLE001 - any failure falls back to literal matching
            matcher_note = type(exc).__name__

    mean_mass = (sum(r.unit.mass for r in results) / len(results)) if results else 1.0
    skills = [
        SkillUnit(
            r.unit.id,
            U.CUE_WEIGHT[r.unit.cue] * F(str(round(r.unit.mass / (mean_mass or 1.0), 6))),
            r.credit,
            high_credit=r.high_credit if (r.high_credit and r.high_credit > r.credit) else None,
        )
        for r in results
    ]
    spans = U.skill_like_spans(results, index)
    years_res = assess_years(index.text, jd_text, spans, as_of=as_of)
    gates = _jd_gates(jd_text, index.text, years_res.candidate_years, as_of)
    years = None
    if years_res.required_years is not None and years_res.required_years > 0:
        def dec(v: Any) -> F | None:
            return None if v is None else F(str(v))

        years = YearsInput(
            dec(years_res.required_years), dec(years_res.candidate_years),
            dec(years_res.low_years), dec(years_res.high_years),
        )
    engine_gates = [GateUnit(g.id, g.weight, g.outcome.status, g.mandatory) for g in gates]
    public = _PUBLIC_SECTOR.search(jd_text)
    resume_unsupported = unsupported_fraction(resume_text)
    jd_unsupported = unsupported_fraction(jd_text)
    worst = max(resume_unsupported, jd_unsupported)
    flags = Flags(
        public_sector=bool(public),
        parse_failed=parse_failed,
        unsupported_script_majority=worst >= 0.5,
        partial_unsupported_script=0.05 < worst < 0.5,
    )
    total = len(skills) + len(engine_gates) + (1 if years else 0)
    curve = curve or _curve()
    result = evaluate(skills, years, engine_gates, total_units=total, flags=flags, curve=curve)

    by_id = {r.unit.id: r for r in results}
    gate_by_id = {g.id: g for g in gates}
    gaps: list[dict[str, Any]] = []
    for gain in result.gains:
        if gain.kind == "skill" and _clean(by_id[gain.unit_id].unit.text).lower() == _clean(
            jd_title_text(jd_text)
        ).lower():
            continue
        if gain.kind == "skill":
            r = by_id[gain.unit_id]
            name, tip = r.unit.text[:140], _tip(r, idf)
        else:
            g = gate_by_id[gain.unit_id]
            name, tip = g.label, f"{g.label}: {g.outcome.reason}"
        gaps.append({"requirement": name, "kind": gain.kind,
                     "points_if_closed": round(float(gain.points), 1), "tip": tip})

    listed = {g["requirement"] for g in gaps}
    job_title = _clean(jd_title_text(jd_text)).lower()
    for r in results:
        name = r.unit.text[:140]
        if _clean(r.unit.text).lower() == job_title:
            continue  # the title line is not a requirement to act on
        if name not in listed and _status(r) != "Met" and r.missing:
            gaps.append({"requirement": name, "kind": "skill", "points_if_closed": 0.0,
                         "tip": _tip(r, idf)})
    gaps.sort(key=lambda g: -g["points_if_closed"])
    gaps = gaps[:12]

    unit_rows = []
    for r in results:
        best = max(r.hits, key=lambda h: (h.mult, -h.start), default=None)
        unit_rows.append({
            "id": r.unit.id, "skill": r.unit.text[:140], "cue": r.unit.cue,
            "weight": float(U.CUE_WEIGHT[r.unit.cue]), "credit": round(float(r.credit), 3),
            "status": _status(r), "evidence": None if best is None else best.quote,
            "start": None if best is None else best.start,
            "end": None if best is None else best.end,
            "context": None if best is None else best.context,
            "evidence_kind": "meaning" if best is not None and best.term == "meaning match" else "words",
            "matched_terms": sorted({h.term.replace("_", " ") for h in r.hits})[:12],
            "missing_terms": sorted(
                (t.replace("_", " ") for t in r.missing if " " not in t),
                key=lambda t: -idf.idf(t.replace(" ", "_")),
            )[:12],
        })
    fit = roles_mod.role_fit(jd_text, index.text, as_of)
    if fit["relation"] in ("related role", "same field", "different field") and fit["note"]:
        extra = {
            "related role": " Lead with the overlapping work in your summary and first bullets.",
            "same field": " Show the parts of your work that match what this job does.",
            "different field": (
                " If you are changing fields, put transferable skills, training and certificates for "
                "the new field near the top of the resume."
            ),
        }[fit["relation"]]
        gaps.insert(0, {"requirement": "Role fit", "kind": "role", "points_if_closed": 0.0,
                        "tip": fit["note"] + extra})
    must_missing = [u["skill"] for u in unit_rows if u["cue"] == "Required" and u["credit"] == 0]
    confirm = [
        {"requirement": g.label, "reason": g.outcome.reason}
        for g in gates if g.outcome.status in ("Unknown", "Confirm")
    ]
    confirm_only = [
        {"type": key, "text": m.group(0), "start": m.start(), "end": m.end()}
        for key, pattern in _CONFIRM_ONLY.items() for m in pattern.finditer(jd_text)
    ]
    jd_level = _level(jd_text[:600])
    resume_level = _level(index.text[:3000])
    signals = {
        "jd_level": None if jd_level is None else _LEVEL_NAME[jd_level],
        "resume_level": None if resume_level is None else _LEVEL_NAME[resume_level],
        "level_gap": None if jd_level is None or resume_level is None else jd_level - resume_level,
        "must_haves_missing": must_missing[:8],
    }
    limitations = [
        "Matching reads the job's own wording and the resume's wording; different phrasing for the "
        "same skill can be missed.",
        "Licence and degree matching reads only what the resume states; it verifies nothing.",
    ]
    if not curve.fitted:
        limitations.append("The score curve is a placeholder and is not calibrated on labeled data yet.")
    if index.hidden_text:
        limitations.append("Invisible characters were found in the resume and removed before scoring.")
    if matcher_note:
        limitations.append("Meaning matching was unavailable for this result, so only exact wording "
                           f"was compared ({matcher_note}).")
    if seg.not_evaluated:
        limitations.append(f"{seg.not_evaluated} lower-priority requirement lines were not evaluated.")

    base: dict[str, Any] = {
        "version": VERSION,
        "engine": {
            "extraction": extraction, "idf_corpus": idf.version,
            "coverage_curve": curve.version, "curve_fitted": curve.fitted,
        },
        "guidance": "Guidance based on what the resume says. It is not a hiring decision.",
        "limitations": limitations, "confirm_only": confirm_only, "confirm": confirm, "gaps": gaps,
        "skill_units": unit_rows,
        "gate_units": [
            {"id": g.id, "requirement": g.label, "status": g.outcome.status,
             "reason": g.outcome.reason, "mandatory": g.mandatory, "cue": g.cue}
            for g in gates
        ],
        "years": {
            "required": None if years_res.required_years is None else str(years_res.required_years),
            "candidate": None if years_res.candidate_years is None else str(years_res.candidate_years),
            "low": None if years_res.low_years is None else str(years_res.low_years),
            "high": None if years_res.high_years is None else str(years_res.high_years),
            "source": years_res.source, "flags": list(years_res.flags),
        },
        "signals": signals,
        "role_fit": fit,
        "soft_skills_not_scored": list(seg.soft_skills),
        "stuffing_guard_applied": False,
        "public_sector_cue": public.group(0) if public else None,
    }
    if result.observed is None:
        return {**base, "state": "ABSTAIN", "tier": result.tier, "score": None, "raw_score": None,
                "capped_score": None, "verdict": None, "band_range": None, "confidence": "Low",
                "confidence_reasons": [], "verdict_withheld": True,
                "withheld_reason": result.withheld_reason, "score_range": None,
                "components": {}, "coverage": None}
    obs = result.observed
    tier, reasons = result.tier, list(result.confidence_reasons)
    if tier == "Firm" and not curve.fitted:
        tier = "Tentative"
        reasons.append("the score curve is not calibrated on labeled data yet")
    return {
        **base,
        "state": "SCORED",
        "tier": tier,
        "score": obs.score,
        "raw_score": str(float(obs.raw)),
        "capped_score": str(float(obs.capped)),
        "verdict": result.band,
        "band_range": list(result.band_range) if result.band_range else None,
        "confidence": result.confidence,
        "confidence_reasons": reasons,
        "verdict_withheld": result.verdict_withheld,
        "withheld_reason": result.withheld_reason,
        "score_range": [result.low, result.high] if result.low != result.high else None,
        "gate_cap": result.gate_cap,
        "components": {k: str(float(v)) for k, v in obs.components.items()},
        "component_points": {k: round(float(v), 1) for k, v in obs.points.items()},
        "coverage": {"ratio": round(float(result.coverage or 0), 3), "total_units": total,
                     "raw_requirement_coverage": round(float(U.coverage(results)), 4)},
    }
