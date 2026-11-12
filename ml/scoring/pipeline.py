"""Evidence-to-engine adapter: one call turns (resume text, JD text) into the stored
`item1Result` payload. All numbers come from `engine.evaluate` (exact, deterministic).

Current extraction coverage (be honest in `limitations`): catalogued software/IT skills,
education levels, and the credentials in `ml/data/credential_registry.json`. Skills
outside the software/IT catalogue are not assessed yet.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import date
from fractions import Fraction as F
from functools import lru_cache
from pathlib import Path
from typing import Any

from ml.scoring.engine import Flags, GateUnit, Result, SkillUnit, YearsInput, evaluate
from ml.scoring.gates import (
    CredentialFact,
    CredentialRequirement,
    EducationFact,
    GateOutcome,
    evaluate_credential,
    evaluate_education,
)
from ml.scoring.item1_assessment import _CONFIRM_ONLY, _PUBLIC_SECTOR
from ml.scoring.item1_extraction import (
    PREFERRED_CUE,
    REQUIRED_CUE,
    assess_software_it_skills,
)
from ml.scoring.item1_years import assess_years

VERSION = "unified-1.0"
DATA = Path(__file__).resolve().parents[1] / "data"
_PLAIN_LEVEL_WORDS = {"bachelor", "bachelor's", "master", "master's"}
_FOLLOW = re.compile(r"\s*(?:degree|of|in)\b", re.I)
_ALT_YEARS = re.compile(r"\b(?:or|/)\s+(?:equivalent\s+)?(\d+)\+?\s*(?:years?|yrs?)\b", re.I)
_VAGUE = re.compile(r"\bor\s+equivalent\b", re.I)


@lru_cache(maxsize=1)
def _education() -> tuple[list[tuple[str, int, bool]], tuple[str, ...]]:
    """[(alias, level, case_sensitive)] and the in-progress cues."""
    data = json.loads((DATA / "item1_education_levels.json").read_text(encoding="utf-8"))
    rows = [
        (a, lvl["ordinal"], len(a) <= 4 and a.lower() not in _PLAIN_LEVEL_WORDS)
        for lvl in data["levels"]
        for a in lvl["aliases"]
    ]
    return rows, tuple(data["in_progress_cues"])


@lru_cache(maxsize=1)
def _registry() -> list[dict[str, Any]]:
    path = DATA / "credential_registry.json"
    return json.loads(path.read_text(encoding="utf-8"))["entries"] if path.exists() else []


def _alias_regex(alias: str, case_sensitive: bool) -> re.Pattern[str]:
    flags = 0 if case_sensitive else re.I
    return re.compile(r"(?<![A-Za-z0-9_])" + re.escape(alias) + r"(?![A-Za-z0-9_])", flags)


def _education_hits(line: str) -> list[int]:
    rows, _ = _education()
    levels: list[int] = []
    for alias, level, cs in rows:
        if alias.lower() in _PLAIN_LEVEL_WORDS:
            # "Bachelors degree", "Master's of Science": plural and possessive forms count
            base = alias.lower().removesuffix("'s")
            pattern = re.compile(
                r"(?<![A-Za-z0-9_])" + re.escape(base) + r"(?:'s|’s|s)?(?![A-Za-z0-9_])", re.I
            )
            for m in pattern.finditer(line):
                if _FOLLOW.match(line, m.end()):
                    levels.append(level)
            continue
        for m in _alias_regex(alias, cs).finditer(line):
            levels.append(level)
    return levels


def _line_cue(line: str) -> str:
    required, preferred = bool(REQUIRED_CUE.search(line)), bool(PREFERRED_CUE.search(line))
    if required and not preferred:
        return "Required"
    if preferred and not required:
        return "Preferred"
    return "Unlabelled"


_CUE_WEIGHT = {"Required": F(1), "Unlabelled": F(3, 4), "Preferred": F(1, 2)}


@dataclass
class _Gate:
    id: str
    label: str
    cue: str
    kind: str  # "education" | "credential"
    outcome: GateOutcome
    mandatory: bool
    weight: F


def _resume_education(resume: str) -> list[EducationFact]:
    _, cues = _education()
    facts: list[EducationFact] = []
    for line in resume.splitlines():
        lowered = line.casefold()
        for level in _education_hits(line):
            progress = any(c in lowered for c in cues)
            facts.append(EducationFact(level, "in_progress" if progress else "completed"))
    return facts


def _resume_credentials(resume: str) -> list[CredentialFact]:
    facts: list[CredentialFact] = []
    for entry in _registry():
        for stage in entry["stages"]:
            hit = any(re.search(p, resume) for p in stage["cue_patterns"]) or any(
                _alias_regex(a["text"], len(a["text"]) <= 3).search(resume) if stage["ordinal"] == 1 else False
                for a in entry["aliases"]
            )
            if hit:
                facts.append(CredentialFact(entry["credential_id"], stage["ordinal"]))
    # a higher stage subsumes lower ones; keep the best per credential
    best: dict[str, CredentialFact] = {}
    for f in facts:
        if f.credential_id not in best or f.stage_ordinal > best[f.credential_id].stage_ordinal:
            best[f.credential_id] = f
    return list(best.values())


def _jd_gates(jd: str, resume: str, candidate_years: Any, as_of: date) -> list[_Gate]:
    gates: list[_Gate] = []
    edu_facts = _resume_education(resume)
    cred_facts = _resume_credentials(resume)
    seen: set[str] = set()
    for n, line in enumerate(jd.splitlines(), start=1):
        if not line.strip():
            continue
        cue = _line_cue(line)
        levels = _education_hits(line)
        if levels and "edu" not in seen:
            seen.add("edu")
            alt = _ALT_YEARS.search(line)
            outcome = evaluate_education(
                min(levels),
                edu_facts,
                alt_years=int(alt.group(1)) if alt else None,
                candidate_years=candidate_years,
                vague_equivalent=bool(_VAGUE.search(line)) and not alt,
            )
            gates.append(
                _Gate(f"education@{n}", "Education requirement", cue, "education", outcome,
                      cue == "Required", _CUE_WEIGHT[cue] if cue != "Required" else F(1))
            )
        for entry in _registry():
            cid = entry["credential_id"]
            if cid in seen:
                continue
            if not any(_alias_regex(a["text"], len(a["text"]) <= 3).search(line) for a in entry["aliases"]):
                continue
            seen.add(cid)
            policy = entry["gate_policy"]["when_jd_required"]
            if policy == "confirm_only":
                continue
            req_stage = 0
            for stage in entry["stages"]:
                if any(re.search(p, line) for p in stage["cue_patterns"]):
                    req_stage = max(req_stage, stage["ordinal"])
            req_stage = req_stage or max(s["ordinal"] for s in entry["stages"])
            lower_in_path = any(s["in_pathway"] for s in entry["stages"] if s["ordinal"] < req_stage)
            outcome = evaluate_credential(
                CredentialRequirement(cid, req_stage, None, lower_in_path), cred_facts, as_of
            )
            mandatory = policy == "mandatory_gate" and cue == "Required"
            gates.append(
                _Gate(cid, entry["display_name"], cue, "credential", outcome, mandatory,
                      F(1) if mandatory else _CUE_WEIGHT[cue])
            )
    return gates[:10]


def _tip_skill(unit: dict[str, Any]) -> str:
    if unit["status"] == "Possible":
        return f"Confirm your proficiency with {unit['skill']} and describe where you used it."
    return f"Add a project or job bullet showing where you used {unit['skill']}."


def assess_pair_v30(resume_text: str, jd_text: str, *, as_of: date | None = None) -> dict[str, Any]:
    """Deterministic score + explanation payload for one resume and one JD."""
    as_of = as_of or date.today()
    resume_text, jd_text = resume_text or "", jd_text or ""
    skill_result = assess_software_it_skills(resume_text, jd_text)
    raw_units = skill_result["units"]
    years_res = assess_years(resume_text, jd_text, raw_units, as_of=as_of)
    gates = _jd_gates(jd_text, resume_text, years_res.candidate_years, as_of)
    public = _PUBLIC_SECTOR.search(jd_text)

    skills = [
        SkillUnit(
            u["skill"], F(str(u["weight"])), F(str(u["credit"])),
            F(1, 2) if u["status"] == "Possible" else None,
        )
        for u in raw_units
    ]
    years = None
    if years_res.required_years is not None and years_res.required_years > 0:
        dec = lambda v: None if v is None else F(str(v))  # noqa: E731
        years = YearsInput(dec(years_res.required_years), dec(years_res.candidate_years),
                           dec(years_res.low_years), dec(years_res.high_years))
    engine_gates = [GateUnit(g.id, g.weight, g.outcome.status, g.mandatory) for g in gates]
    total = len(skills) + len(engine_gates) + (1 if years else 0)
    result: Result = evaluate(skills, years, engine_gates, total_units=total,
                              flags=Flags(public_sector=bool(public)))

    unit_by_id = {u["skill"]: u for u in raw_units}
    gate_by_id = {g.id: g for g in gates}
    gaps: list[dict[str, Any]] = []
    for gain in result.gains:
        if gain.kind == "skill":
            tip = _tip_skill(unit_by_id[gain.unit_id])
            name = gain.unit_id
        else:
            g = gate_by_id[gain.unit_id]
            tip = f"{g.label}: {g.outcome.reason}"
            name = g.label
        gaps.append({"requirement": name, "kind": gain.kind,
                     "points_if_closed": round(float(gain.points), 1), "tip": tip})
    confirm = [
        {"requirement": g.label, "reason": g.outcome.reason}
        for g in gates if g.outcome.status in ("Unknown", "Confirm")
    ]
    confirm_only = [
        {"type": key, "text": m.group(0), "start": m.start(), "end": m.end()}
        for key, pattern in _CONFIRM_ONLY.items() for m in pattern.finditer(jd_text)
    ]
    limitations = [
        "Skills are checked against the software/IT catalogue only; other fields rely on "
        "years and education/credential checks.",
        "Licence and degree matching reads only what the resume states; it verifies nothing.",
    ]
    if not skills:
        limitations.append("No catalogued skills were found in the job description.")

    base: dict[str, Any] = {
        "version": VERSION,
        "guidance": "Guidance based on what the resume says. It is not a hiring decision.",
        "limitations": limitations,
        "confirm_only": confirm_only,
        "confirm": confirm,
        "gaps": gaps,
        "skill_units": raw_units,
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
            "source": years_res.source,
            "flags": list(years_res.flags),
        },
        "stuffing_guard_applied": skill_result["stuffing_guard_applied"],
        "public_sector_cue": public.group(0) if public else None,
    }
    if result.status != "scored" or result.observed is None:
        return {**base, "state": "ABSTAIN", "score": None, "raw_score": None, "capped_score": None,
                "verdict": None, "confidence": "Low", "verdict_withheld": True,
                "withheld_reason": "The job description has too few assessable requirements.",
                "score_range": None, "components": {}, "coverage": None,
                "confidence_reasons": ["no assessable requirements"]}
    obs = result.observed
    return {
        **base,
        "state": "SCORED",
        "score": obs.score,
        "raw_score": str(float(obs.raw)),
        "capped_score": str(float(obs.capped)),
        "verdict": result.band,
        "confidence": result.confidence,
        "confidence_reasons": result.confidence_reasons,
        "verdict_withheld": result.verdict_withheld,
        "withheld_reason": result.withheld_reason,
        "score_range": [result.low, result.high] if result.low != result.high else None,
        "gate_cap": result.gate_cap,
        "components": {k: str(float(v)) for k, v in obs.components.items()},
        "component_points": {k: round(float(v), 1) for k, v in obs.points.items()},
        "coverage": {"ratio": round(float(result.coverage or 0), 3), "total_units": total},
    }


def assess_pair(
    resume_text: str,
    jd_text: str,
    *,
    as_of: date | None = None,
    parse_failed: bool = False,
    matcher: Any = None,
) -> dict[str, Any]:
    """Entry point used by the worker.
    ITEM12_ENGINE=v32: selects the v3.2 deterministic scoring engine.
    ITEM12_ENGINE=v31 (default): selects the v3.1 engine.
    ITEM12_ENGINE=v30: selects the previous catalogue engine.
    """
    import os

    engine_choice = os.getenv("ITEM12_ENGINE", "v31").strip().lower()
    if engine_choice == "v30":
        return assess_pair_v30(resume_text, jd_text, as_of=as_of)
    if engine_choice == "v32":
        from ml.scoring.pipeline_v32 import assess_pair as assess_v32

        return assess_v32(
            resume_text, jd_text, as_of=as_of, parse_failed=parse_failed, matcher=matcher
        )

    from ml.scoring.pipeline_v31 import assess_pair as assess_v31

    return assess_v31(
        resume_text, jd_text, as_of=as_of, parse_failed=parse_failed, matcher=matcher
    )
