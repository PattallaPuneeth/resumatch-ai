"""
Phase 3B & 3C-1: Skill-Gap Analysis and Taxonomy Mapping.

Analyzes alignment between job requirements and resume skills extracted in Phase 2C.
Categorizes skills into matched, missing, and partial matches with coverage metrics.
Uses externalized skill_taxonomy.json for alias/synonym resolution with word-boundary
protection to prevent false positives (e.g. Java vs JavaScript).
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from ml.config import settings

logger = logging.getLogger("resumatch-ml-skillgap")

# Default fallback aliases
SKILL_ALIASES: dict[str, str] = {
    "k8s": "kubernetes",
    "kubernetes": "kubernetes",
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "pgsql": "postgresql",
    "js": "javascript",
    "javascript": "javascript",
    "ts": "typescript",
    "typescript": "typescript",
    "py": "python",
    "python": "python",
    "react": "react",
    "react.js": "react",
    "reactjs": "react",
    "node": "nodejs",
    "node.js": "nodejs",
    "nodejs": "nodejs",
    "aws": "aws",
    "amazon web services": "aws",
    "gcp": "gcp",
    "google cloud platform": "gcp",
    "google cloud": "gcp",
    "docker": "docker",
    "fastapi": "fastapi",
    "redis": "redis",
    "graphql": "graphql",
}

_TAXONOMY_PATH = Path(__file__).parent / "skill_taxonomy.json"
_SKILL_ALIASES_MAP: dict[str, str] | None = None


def load_skill_aliases(force_reload: bool = False) -> dict[str, str]:
    """Loads and caches canonical skill aliases from skill_taxonomy.json."""
    global _SKILL_ALIASES_MAP
    if _SKILL_ALIASES_MAP is not None and not force_reload:
        return _SKILL_ALIASES_MAP

    aliases = dict(SKILL_ALIASES)
    if _TAXONOMY_PATH.exists():
        try:
            with open(_TAXONOMY_PATH, encoding="utf-8") as f:
                data = json.load(f)
                for canonical, alias_list in data.items():
                    c_norm = canonical.strip().lower()
                    aliases[c_norm] = c_norm
                    if isinstance(alias_list, list):
                        for a in alias_list:
                            if isinstance(a, str):
                                aliases[a.strip().lower()] = c_norm
        except Exception as e:
            logger.warning("Failed to load skill_taxonomy.json, using defaults: %s", e)

    _SKILL_ALIASES_MAP = aliases
    return _SKILL_ALIASES_MAP


def _clean_text(text: str) -> str:
    cleaned = re.sub(r"[^\w\s\.\+#/-]", "", text).strip().lower()
    return re.sub(r"\s+", " ", cleaned)


def _normalize_skill(skill: str) -> str:
    cleaned = _clean_text(skill)
    aliases = load_skill_aliases()
    return aliases.get(cleaned, cleaned)


def _is_word_boundary_match(pattern: str, text: str) -> bool:
    """
    Checks if pattern appears as a distinct word/phrase in text.
    Strictly avoids false positives:
    - 'java' does NOT match 'javascript'
    - 'c' does NOT match 'c++', 'c#', 'css'
    - 'go' does NOT match 'google' or 'django'
    """
    if not pattern or not text:
        return False

    escaped = re.escape(pattern)
    regex = rf"(?:^|[\s,;/()\[\]]){escaped}(?:$|[\s,;/()\[\]])"
    return bool(re.search(regex, text))


def _extract_all_resume_skills(skills_data: Any) -> tuple[set[str], set[str]]:
    """
    Flattens parsed resume skills into:
    (set_of_canonical_normalized_skills, set_of_raw_cleaned_skills)
    """
    if not skills_data:
        return set(), set()

    canonical_set: set[str] = set()
    raw_set: set[str] = set()

    def add_skill(s: str) -> None:
        raw = _clean_text(s)
        if raw:
            raw_set.add(raw)
            canonical = _normalize_skill(raw)
            canonical_set.add(canonical)

    if isinstance(skills_data, list):
        for item in skills_data:
            if isinstance(item, str):
                add_skill(item)
            elif isinstance(item, dict) and "name" in item:
                add_skill(str(item["name"]))
    elif isinstance(skills_data, dict):
        for val in skills_data.values():
            if isinstance(val, list):
                for sub in val:
                    if isinstance(sub, str):
                        add_skill(sub)
                    elif isinstance(sub, dict) and "name" in sub:
                        add_skill(str(sub["name"]))
            elif isinstance(val, str):
                add_skill(val)

    return canonical_set, raw_set


def extract_skills_from_text(text: str) -> list[str]:
    """Extracts canonical taxonomy skills mentioned anywhere in free text (word-boundary match)."""
    if not text:
        return []

    aliases = load_skill_aliases()
    found_canonical: set[str] = set()
    clean_text = text.lower()

    for alias_pattern, canonical in aliases.items():
        escaped = re.escape(alias_pattern)
        regex = rf"(?:^|[\s,;/()\[\].!?:-]){escaped}(?:$|[\s,;/()\[\].!?:-])"
        if re.search(regex, clean_text):
            found_canonical.add(canonical)

    return sorted(found_canonical)


def resolve_required_skills(
    required_skills: list[str] | None,
    job_title: str = "",
    job_description: str = "",
) -> list[str]:
    """
    Returns the job's structured required skills, or, when none were supplied (the UI only
    sends a title and raw description), the taxonomy skills mentioned in the title + description.
    """
    clean = [s for s in (required_skills or []) if isinstance(s, str) and s.strip()]
    if clean:
        return clean
    return extract_skills_from_text(f"{job_title}\n{job_description}")


# Weight of one preferred skill relative to one required skill in the coverage ratio.
# 1.0 treats them alike (the scoring before the split); 0.0 scores required skills only.
# Measured on the eval sets: 0.5 kept handwritten band accuracy, lower weights cost it.
PREFERRED_SKILL_WEIGHT = settings.preferred_skill_weight

_PREFERRED_HEADING = re.compile(
    r"prefer|nice[\s-]to[\s-]have|bonus|desirable|good[\s-]to[\s-]have|\bplus(?:es)?\b",
    re.IGNORECASE,
)
# "Required skills:", "Preferred qualifications:", "Education/experience:" at a sentence start
_INLINE_HEADING = re.compile(r"(?:^|(?<=[.;\n]))[ \t]*([A-Za-z][A-Za-z/&' -]{2,40}):")
_PREFERRED_SENTENCE = re.compile(
    r"\b(?:is|are|would be)\s+(?:a\s+)?(?:plus|bonus|nice to have|preferred|desirable)\b",
    re.IGNORECASE,
)


def _is_heading_line(line: str) -> bool:
    """Short lines without sentence punctuation are section headings ("Preferred Skills")."""
    stripped = line.strip().rstrip(":")
    return (
        0 < len(stripped.split()) <= 5
        and not stripped.endswith(".")
        and not stripped.startswith(("-", "*", "•"))
    )


def _section_starts(text: str) -> list[tuple[int, str]]:
    """Start offsets and heading text of every section, from heading lines and inline headings."""
    starts: list[tuple[int, str]] = []
    offset = 0
    for line in text.splitlines(keepends=True):
        if line.strip() and _is_heading_line(line):
            starts.append((offset, line.strip()))
        offset += len(line)
    for m in _INLINE_HEADING.finditer(text):
        starts.append((m.start(1), m.group(1)))
    return sorted(starts)


def split_required_preferred(
    job_title: str, job_description: str
) -> tuple[list[str], list[str]]:
    """
    Splits the taxonomy skills a JD mentions into (required, preferred).

    A skill is preferred when it appears only under a preferred-style heading ("Preferred Skills",
    "Nice to have", "Bonus") or in a sentence that calls it "a plus". Skills anywhere else, and
    skills in the title, are required. A skill mentioned in both places stays required.
    """
    text = job_description or ""
    starts = _section_starts(text)
    bounds = [0] + [s for s, _ in starts] + [len(text)]
    headings = [""] + [h for _, h in starts]

    required_text: list[str] = [job_title or ""]
    preferred_text: list[str] = []
    for heading, begin, end in zip(headings, bounds[:-1], bounds[1:], strict=False):
        segment = text[begin:end]
        if heading and _PREFERRED_HEADING.search(heading):
            preferred_text.append(segment)
            continue
        for sentence in re.split(r"(?<=[.;])\s+|\n", segment):
            if _PREFERRED_SENTENCE.search(sentence):
                preferred_text.append(sentence)
            else:
                required_text.append(sentence)

    required = extract_skills_from_text("\n".join(required_text))
    required_set = set(required)
    preferred = [
        s for s in extract_skills_from_text("\n".join(preferred_text)) if s not in required_set
    ]
    return required, preferred


_ALTERNATIVE_CLAUSE_SPLIT = re.compile(r"[;\n]|(?<=[.!?])\s+|,(?![^()]*\))")
_OR_WORD = re.compile(r"\bor\b", re.IGNORECASE)


def extract_alternative_groups(text: str) -> list[list[str]]:
    """
    Skills a JD offers as alternatives in one clause ("financial statements or general ledger",
    "FastAPI or a comparable framework such as Flask"). Any one member satisfies the group.
    """
    groups: list[list[str]] = []
    for clause in _ALTERNATIVE_CLAUSE_SPLIT.split(text or ""):
        if clause and _OR_WORD.search(clause):
            skills = extract_skills_from_text(clause)
            if len(skills) >= 2:
                groups.append(skills)
    return groups


def _collapse_alternatives(
    matched: list[str],
    partial: list[str],
    missing: list[str],
    alternatives: list[list[str]],
) -> tuple[list[str], list[str], list[str]]:
    """Counts each alternative group as one requirement: its best-matched member stands for it."""
    for group in alternatives:
        members = {g.lower() for g in group}
        in_m = [s for s in matched if s.lower() in members]
        in_p = [s for s in partial if s.lower() in members]
        in_x = [s for s in missing if s.lower() in members]
        if len(in_m) + len(in_p) + len(in_x) < 2:
            continue
        keep = (in_m or in_p or in_x)[0]
        matched = [s for s in matched if s.lower() not in members or s == keep]
        partial = [s for s in partial if s.lower() not in members or s == keep]
        missing = [s for s in missing if s.lower() not in members or s == keep]
    return matched, partial, missing


def resolve_skill_requirements(
    required_skills: list[str] | None,
    preferred_skills: list[str] | None,
    job_title: str = "",
    job_description: str = "",
) -> tuple[list[str], list[str]]:
    """
    Returns (required, preferred) for coverage scoring. Stored structured skills win; otherwise
    the JD text is split with split_required_preferred. When nothing ends up required, the
    preferred list is promoted so coverage is not dropped.
    """
    req = [s for s in (required_skills or []) if isinstance(s, str) and s.strip()]
    pref = [s for s in (preferred_skills or []) if isinstance(s, str) and s.strip()]
    if not req:
        req, extracted_pref = split_required_preferred(job_title, job_description)
        pref = pref or extracted_pref
    if not req:
        return pref, []
    req_lower = {s.lower() for s in req}
    return req, [s for s in pref if s.lower() not in req_lower]


def analyze_skill_gap(
    required_skills: list[str] | None,
    resume_skills_data: Any,
    preferred_skills: list[str] | None = None,
    resume_text: str | None = None,
    alternatives: list[list[str]] | None = None,
) -> dict[str, Any]:
    """
    Performs skill-gap analysis between job requirements and resume skills.

    Args:
        required_skills: List of required skill strings from the Job record.
        resume_skills_data: Parsed skills from ParsedResume.skills (list or dict).
        preferred_skills: Optional preferred skill strings.
        resume_text: Optional full resume text. Taxonomy skills mentioned anywhere in it count as
            resume skills too, so skills written in experience bullets (not only in the parsed
            skills list) are credited.

    Returns:
        Dict containing:
            - 'matched': list of matched skill names
            - 'partial': list of partially matched skill names
            - 'missing': list of missing skill names
            - 'coverage_ratio': float (0.0 to 1.0), or None when the job has no known
              requirements (coverage is unknown, not perfect; the scorer then drops the term)
            - 'coverageRatio': alias for coverage_ratio
    """
    if not required_skills:
        return {
            "matched": [],
            "partial": [],
            "missing": [],
            "coverage_ratio": None,
            "coverageRatio": None,
        }

    canonical_resume_skills, raw_resume_skills = _extract_all_resume_skills(resume_skills_data)
    if resume_text:
        for skill in extract_skills_from_text(resume_text):
            canonical_resume_skills.add(skill)
            raw_resume_skills.add(skill)

    def classify(skills: list[str]) -> tuple[list[str], list[str], list[str]]:
        matched: list[str] = []
        partial: list[str] = []
        missing: list[str] = []
        for req in skills:
            clean_raw_req = _clean_text(req)
            if not clean_raw_req:
                continue
            canonical_req = _normalize_skill(clean_raw_req)

            # 1. Exact match (by canonical name or raw string)
            if canonical_req in canonical_resume_skills or clean_raw_req in raw_resume_skills:
                matched.append(req)
            # 2. Word-boundary partial match
            elif any(
                _is_word_boundary_match(clean_raw_req, raw_s)
                or _is_word_boundary_match(raw_s, clean_raw_req)
                or _is_word_boundary_match(canonical_req, raw_s)
                for raw_s in raw_resume_skills
            ):
                partial.append(req)
            else:
                missing.append(req)
        return matched, partial, missing

    groups = alternatives or []
    matched, partial, missing = _collapse_alternatives(*classify(required_skills), groups)
    pref_matched, pref_partial, pref_missing = _collapse_alternatives(
        *classify(list(preferred_skills or [])), groups
    )

    # Partial matches receive half credit (0.5); preferred skills count at PREFERRED_SKILL_WEIGHT
    w = PREFERRED_SKILL_WEIGHT
    total: float = len(matched) + len(partial) + len(missing)
    total += w * (len(pref_matched) + len(pref_partial) + len(pref_missing))
    coverage: float | None
    if total == 0:
        coverage = None
    else:
        credit = len(matched) + 0.5 * len(partial)
        credit += w * (len(pref_matched) + 0.5 * len(pref_partial))
        coverage = round(credit / total, 4)

    return {
        "matched": matched,
        "partial": partial,
        "missing": missing,
        "preferred_matched": pref_matched,
        "preferred_partial": pref_partial,
        "preferred_missing": pref_missing,
        "coverage_ratio": coverage,
        "coverageRatio": coverage,
    }
