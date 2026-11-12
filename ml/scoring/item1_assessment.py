"""Conservative Item 1 assessment assembly for the current Software/IT pilot.

The returned score is always marked Low confidence while the JD/resume extraction
catalogue is incomplete. It is deliberately not promoted to a production verdict.
"""

from __future__ import annotations

import re
from datetime import date
from decimal import Decimal
from typing import Any

from ml.scoring.item1 import calculate_score, verdict
from ml.scoring.item1_extraction import assess_software_it_skills
from ml.scoring.item1_years import assess_years

D = Decimal
_GATE_TERMS = re.compile(
    r"\b(?:degree|bachelor(?:'s)?|master(?:'s)?|doctorate|ph\.?d\.?|"
    r"certification|certificate|licen[cs]e|registration|registered)\b",
    re.I,
)
_PUBLIC_SECTOR = re.compile(
    r"\b(?:advertisement\s*(?:no\.?|number|#)|advt\.?\s*(?:no\.?|number|#)|"
    r"notification\s+(?:no\.?|number)|reservation|age\s+relaxation|"
    r"pay\s+(?:matrix|level|scale)|grade\s+pay|7th\s+cpc|\b(?:obc|ews)\b|sc\s*/\s*st|"
    r"as\s+per\s+government\s+norms|as\s+per\s+govt\.?\s+norms|"
    r"government\s+recruitment|public\s+service\s+commission)\b",
    re.I,
)
_CONFIRM_ONLY = {
    "salary": re.compile(r"\b(?:ctc|salary|lpa|compensation|pay range)\b", re.I),
    "notice_period": re.compile(
        r"\b(?:notice period|immediate joiner|joining immediately)\b", re.I
    ),
    "location": re.compile(
        r"\b(?:relocation|work location|based in|onsite|on-site|hybrid)\b", re.I
    ),
    "shift_or_travel": re.compile(
        r"\b(?:shift|night shift|travel required|willingness to travel)\b", re.I
    ),
    "protected_or_public_condition": re.compile(
        r"\b(?:age|gender|marital status|domicile|reservation|caste|religion|"
        r"physical standards|medical fitness|freshers only|security clearance|bond)\b",
        re.I,
    ),
}


def _unknown_gate_units(jd_text: str) -> list[dict[str, Any]]:
    """Leave obvious education/credential gates unresolved instead of inferring from silence."""
    rows: list[dict[str, Any]] = []
    for line_no, line in enumerate((jd_text or "").splitlines(), start=1):
        match = _GATE_TERMS.search(line)
        if not match:
            continue
        lowered = line.casefold()
        if any(
            token in lowered for token in ("required", "must", "mandatory", "essential", "minimum")
        ):
            cue = "Required"
            mandatory = True
            weight = 1.0
        elif any(token in lowered for token in ("preferred", "desirable", "nice to have", "plus")):
            cue = "Preferred"
            mandatory = False
            weight = 0.5
        else:
            cue = "Unlabelled"
            mandatory = False
            weight = 0.75
        rows.append(
            {
                "type": "unresolved_gate",
                "cue": cue,
                "term": match.group(0),
                "line": line_no,
                "status": "Unknown",
                "mandatory": mandatory,
                "weight": weight,
                "reason": "Education and credential gate matching is not yet implemented.",
            }
        )
    return rows[:10]


def _score_for(
    skill_units: list[dict[str, Any]],
    years_value: Decimal | None,
    required_years: Decimal | None,
    gate_units: list[dict[str, Any]],
    override: str | None = None,
):
    skills = [(unit["weight"], unit["credit"]) for unit in skill_units]
    years = None if years_value is None or required_years is None else (years_value, required_years)
    gates = [(unit["weight"], unit["status"], unit["mandatory"]) for unit in gate_units]
    return calculate_score(skills, years, gates, override=override)


def assess_item1_software_it(
    resume_text: str,
    jd_text: str,
    *,
    as_of: date | None = None,
) -> dict[str, Any]:
    """Assemble a transparent, low-confidence Item 1 score for Software/IT.

    This preserves the Item 1 scoring formula and range semantics while withholding
    the verdict because the current parser does not cover the complete design.
    """
    skill_result = assess_software_it_skills(resume_text, jd_text)
    skill_units = skill_result["units"]
    years_result = assess_years(resume_text, jd_text, skill_units, as_of=as_of)
    gate_units = _unknown_gate_units(jd_text)

    observed = _score_for(
        skill_units,
        years_result.candidate_years,
        years_result.required_years,
        gate_units,
    )
    public_match = _PUBLIC_SECTOR.search(jd_text or "")
    confirm_only = [
        {"type": key, "text": m.group(0), "start": m.start(), "end": m.end()}
        for key, pattern in _CONFIRM_ONLY.items()
        for m in pattern.finditer(jd_text or "")
    ]

    range_scores: list[int] = []
    unresolved_gates = any(unit["status"] in {"Unknown", "Confirm"} for unit in gate_units)
    uncertain_years = years_result.low_years != years_result.high_years
    if observed is not None and (unresolved_gates or uncertain_years):
        year_candidates = {years_result.candidate_years}
        if uncertain_years:
            year_candidates.update((years_result.low_years, years_result.high_years))
        for years_value in year_candidates:
            if unresolved_gates:
                for override in ("Not met", "Met"):
                    scenario = _score_for(
                        skill_units,
                        years_value,
                        years_result.required_years,
                        gate_units,
                        override=override,
                    )
                    if scenario is not None:
                        range_scores.append(scenario.score)
            else:
                scenario = _score_for(
                    skill_units,
                    years_value,
                    years_result.required_years,
                    gate_units,
                )
                if scenario is not None:
                    range_scores.append(scenario.score)

    assessable_units = len(skill_units)
    recognized_units = len(skill_units) + len(gate_units)
    limitations = [
        (
            "Skill catalogue and cue parser are incomplete; engineering review only, "
            "not ready for user-facing launch."
        ),
        (
            "Education and credential requirements remain unresolved; "
            "no status is inferred from silence."
        ),
        (
            "Concept matching, OR-groups, unlisted requirements, OCR review, hidden-text "
            "checks and full language gating are not implemented."
        ),
    ]
    if gate_units:
        limitations.append("One or more education/credential gates need explicit classification.")
    if public_match:
        limitations.append(
            "Government/public-sector recruitment cues detected; eligibility comes from "
            "the notification."
        )

    state = "ABSTAIN" if observed is None else "SCORED"
    low_confidence = True  # Required until the remaining V1 extraction and coverage gates exist.
    score = None if observed is None else observed.score
    return {
        "version": "item1-india-it-prototype-0.1",
        "state": state,
        "score": score,
        "raw_score": None if observed is None else str(observed.raw),
        "capped_score": None if observed is None else str(observed.capped),
        "verdict": None if score is None or low_confidence or public_match else verdict(score),
        "confidence": "Low" if low_confidence else "Medium",
        "verdict_withheld": bool(low_confidence or public_match),
        "withheld_reason": (
            "Not enough validated extraction coverage for a verdict."
            if low_confidence
            else "Public-sector recruitment cue requires notification review."
            if public_match
            else None
        ),
        "score_range": [min(range_scores), max(range_scores)] if range_scores else None,
        "components": {}
        if observed is None
        else {key: str(value) for key, value in observed.components.items()},
        "coverage": {
            "assessable": assessable_units,
            "total": None,
            "ratio": None,
            "recognized_units": recognized_units,
            "note": "The full JD requirement denominator is unavailable in this prototype.",
        },
        "skill_units": skill_units,
        "gate_units": gate_units,
        "years": {
            "required": None
            if years_result.required_years is None
            else str(years_result.required_years),
            "candidate": None
            if years_result.candidate_years is None
            else str(years_result.candidate_years),
            "low": None if years_result.low_years is None else str(years_result.low_years),
            "high": None if years_result.high_years is None else str(years_result.high_years),
            "source": years_result.source,
            "flags": list(years_result.flags),
        },
        "confirm_only": confirm_only,
        "public_sector_cue": None if public_match is None else public_match.group(0),
        "stuffing_guard_applied": skill_result["stuffing_guard_applied"],
        "limitations": limitations,
        "guidance": "Guidance based on what the resume says. It is not a hiring decision.",
    }
