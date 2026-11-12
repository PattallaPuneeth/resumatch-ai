"""Conservative software/IT requirement and evidence extraction for Item 1.

This is an initial, bounded parser. It extracts catalogued technology names and
verified aliases with exact offsets; it does not infer semantic equivalence.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace
from typing import Literal

from ml.scoring.item1 import calculate_score

Cue = Literal["Required", "Preferred", "Unlabelled"]
SKILL_CATALOG = (
    "Python",
    "Java",
    "JavaScript",
    "TypeScript",
    "React",
    "Node.js",
    "Kubernetes",
    "Docker",
    "PostgreSQL",
    "SQL",
    "Redis",
    "MongoDB",
    "Amazon Web Services",
    "Google Cloud Platform",
    "Microsoft Azure",
    "Linux",
    "Git",
    "REST API",
    "GraphQL",
    "FastAPI",
    "Django",
    "Flask",
    "Spring",
    "HTML",
    "CSS",
    "Terraform",
    "Ansible",
    "Kafka",
    "Microservices",
    "GitHub Actions",
    "Jenkins",
)


def _load_domain_catalog() -> tuple[tuple[str, ...], dict[str, frozenset[str]]]:
    """Skills beyond the first IT pilot (ml/data/skills_catalog_domains.json). Literal only."""
    import json
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "data" / "skills_catalog_domains.json"
    if not path.exists():
        return (), {}
    rows = json.loads(path.read_text(encoding="utf-8"))["skills"]
    names = tuple(row["skill"] for row in rows)
    aliases = {
        row["skill"].casefold(): frozenset(
            {row["skill"].casefold(), *(a.casefold() for a in row["aliases"])}
        )
        for row in rows
    }
    return names, aliases


_DOMAIN_SKILLS, _DOMAIN_ALIASES = _load_domain_catalog()
ALL_SKILLS = SKILL_CATALOG + tuple(s for s in _DOMAIN_SKILLS if s not in SKILL_CATALOG)
REQUIRED_CUE = re.compile(
    r"\b(?:required|requirement|requirements|must[- ]have|mandatory|essential|"
    r"minimum qualification|compulsory)\b",
    re.I,
)
PREFERRED_CUE = re.compile(
    r"\b(?:preferred|desirable|good to have|nice to have|added advantage|"
    r"is a plus|are a plus|bonus)\b",
    re.I,
)
NOT_MANDATORY = re.compile(r"\bnot mandatory\b", re.I)
BULLET = re.compile(r"^\s*(?:[-*•‣▪]|\d+[.)])\s*")
SECTION_LIST = re.compile(
    r"\b(?:skills?|technologies|technical stack|tooling|competenc\w*|tools|expertise|proficienc\w*)\b",
    re.I,
)
SECTION_EXPERIENCE = re.compile(
    r"\b(?:experience|employment|work history|professional history|projects?)\b", re.I
)
NEGATIVE = re.compile(r"\b(?:no|not|never|without|lack(?:s|ing)?)\b", re.I)
POSSIBLE = re.compile(r"\b(?:learning|basic exposure|exposure to|pursuing|familiar with)\b", re.I)


@dataclass(frozen=True)
class SkillUnit:
    skill: str
    cue: Cue
    weight: float
    credit: float
    status: Literal["Direct", "Possible", "Not evidenced"]
    evidence: str | None
    start: int | None
    end: int | None
    context: Literal["experience", "skills_list", "other", "missing"]


def _aliases(skill: str) -> frozenset[str]:
    from ml.scoring.item1 import load_verified_alias_map

    if skill.casefold() in _DOMAIN_ALIASES:
        return _DOMAIN_ALIASES[skill.casefold()]

    aliases = load_verified_alias_map()
    return next(
        (
            values
            for canonical, values in aliases.items()
            if skill.casefold() == canonical or skill.casefold() in values
        ),
        frozenset({skill.casefold()}),
    )


def _all_hits(skill: str, text: str) -> list[tuple[str, int, int]]:
    hits: list[tuple[str, int, int]] = []
    for alias in _aliases(skill):
        pattern = re.compile(r"(?<![A-Za-z0-9_])" + re.escape(alias) + r"(?![A-Za-z0-9_])", re.I)
        hits.extend((m.group(0), m.start(), m.end()) for m in pattern.finditer(text))
    return sorted(hits, key=lambda item: item[1])


def _line_cue(line: str, inherited: Cue) -> Cue:
    if NOT_MANDATORY.search(line):
        return "Preferred"
    required = bool(REQUIRED_CUE.search(line))
    preferred = bool(PREFERRED_CUE.search(line))
    if required and preferred:
        return "Unlabelled"
    if required:
        return "Required"
    if preferred:
        return "Preferred"
    return inherited


def _is_heading(line: str) -> bool:
    clean = BULLET.sub("", line).strip().rstrip(":")
    words = clean.split()
    return (
        bool(clean)
        and len(words) <= 5
        and not BULLET.match(line)
        and (line.strip().endswith(":") or not re.search(r"[.!?]", clean))
    )


def _requirements(jd_text: str) -> dict[str, Cue]:
    found: dict[str, Cue] = {}
    explicit_cues: dict[str, set[Cue]] = {}
    inherited: Cue = "Unlabelled"
    offset = 0
    for line in jd_text.splitlines(keepends=True):
        clean = line.strip()
        if _is_heading(line):
            lowered = clean.casefold()
            if any(word in lowered for word in ("preferred", "desirable", "nice to have", "bonus")):
                inherited = "Preferred"
            elif any(
                word in lowered for word in ("requirement", "required", "must have", "mandatory")
            ):
                inherited = "Required"
            else:
                inherited = "Unlabelled"
        line_cue = _line_cue(line, inherited)
        for skill in ALL_SKILLS:
            for _, _start, _ in _all_hits(skill, line):
                if line_cue in {"Required", "Preferred"}:
                    explicit_cues.setdefault(skill, set()).add(line_cue)
                    found[skill] = (
                        "Unlabelled"
                        if len(explicit_cues[skill]) > 1
                        else line_cue
                    )
                elif skill not in found:
                    found[skill] = "Unlabelled"
        offset += len(line)
    return found


def _resume_context(text: str, start: int) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    prior_lines = [ln for ln in text[:line_start].splitlines() if ln.strip()]  # blank lines add no context
    mode = "other"
    for line in prior_lines[-20:]:
        clean = line.strip()
        if not clean:
            continue
        if _is_heading(line):
            if SECTION_LIST.search(clean):
                mode = "skills_list"
            elif SECTION_EXPERIENCE.search(clean):
                mode = "experience"
    return mode


def _evidence_credit(text: str, hit: tuple[str, int, int]) -> tuple[float, str, str]:
    exact, start, end = hit
    context = _resume_context(text, start)
    tokens = list(re.finditer(r"\b[\w+#.]+\b", text))
    hit_indices = [
        index
        for index, token in enumerate(tokens)
        if token.start() < end and start < token.end()
    ]
    if hit_indices:
        first, last = hit_indices[0], hit_indices[-1]
        vicinity = tokens[max(0, first - 6) : min(len(tokens), last + 7)]
        around = " ".join(token.group(0) for token in vicinity)
    else:
        around = exact
    if NEGATIVE.search(around) or POSSIBLE.search(around):
        return 0.0, "Possible", context
    if context == "skills_list":
        return 0.8, "Direct", context
    return 1.0, "Direct", context


def assess_software_it_skills(resume_text: str, jd_text: str) -> dict:
    """Return catalogued IT skill units, exact evidence spans, and skill-only score.

    This bounded result must not be presented as a complete Item 1 verdict; years,
    credentials, OR-groups, broader aliases, and unlisted requirements are not covered.
    """
    requirements = _requirements(jd_text)
    units: list[SkillUnit] = []
    for skill, cue in requirements.items():
        hits = _all_hits(skill, resume_text)
        if hits:
            selected = max(hits, key=lambda hit: _evidence_credit(resume_text, hit)[0])
            credit, status, context = _evidence_credit(resume_text, selected)
            units.append(
                SkillUnit(
                    skill,
                    cue,
                    {"Required": 1.0, "Unlabelled": 0.75, "Preferred": 0.5}[cue],
                    credit,
                    status,
                    selected[0],
                    selected[1],
                    selected[2],
                    context,
                )
            )
        else:
            units.append(
                SkillUnit(
                    skill,
                    cue,
                    {"Required": 1.0, "Unlabelled": 0.75, "Preferred": 0.5}[cue],
                    0.0,
                    "Not evidenced",
                    None,
                    None,
                    None,
                    "missing",
                )
            )
    units.sort(key=lambda unit: (unit.cue != "Required", unit.start or 0))
    units = units[:25]
    required_units = [unit for unit in units if unit.cue == "Required"]
    list_only_required = [
        unit
        for unit in required_units
        if unit.credit > 0 and unit.context == "skills_list"
    ]
    has_role_or_project_evidence = any(
        unit.credit > 0 and unit.context == "experience" for unit in required_units
    )
    stuffing_guard = (
        len(required_units) >= 5
        and len(list_only_required) / len(required_units) >= 0.8
        and not has_role_or_project_evidence
    )
    if stuffing_guard:
        units = [
            replace(unit, credit=0.5)
            if unit.cue == "Required" and unit.context == "skills_list" and unit.credit > 0
            else unit
            for unit in units
        ]
    score = calculate_score([(unit.weight, unit.credit) for unit in units], None, [])
    return {
        "units": [unit.__dict__ for unit in units],
        "score": None if score is None else score.score,
        "coverage": None if not units else sum(u.credit > 0 for u in units) / len(units),
        "stuffing_guard_applied": stuffing_guard,
        "limitations": [
            "skill-only diagnostic, not a complete Item 1 verdict",
            ("years, credentials, OR-groups, aliases, and unlisted requirements are not assessed"),
            "cue and evidence extraction require review against representative examples",
        ],
    }
