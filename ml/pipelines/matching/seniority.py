"""
Seniority signal: years of experience a JD asks for vs what the resume shows.

Explanation only. It is reported with every match but does not change the score: on the eval
sets a conservative penalty would touch 1 of 761 pairs (already labeled and scored weak), so
there is no evidence yet that it improves ranking (docs/eval/ML_FAILURE_ANALYSIS.md section 8.5).
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

_MONTHS = ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec")
_MONTH_RE = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec"
# "�" covers dashes lost to bad text encoding in real exports ("2010�Present")
_DATE_RANGE = re.compile(
    rf"(?:(?P<m1>{_MONTH_RE})[a-z]*\.?\s+)?(?P<y1>(?:19|20)\d\d)\s*(?:-|–|—|�|to)\s*"
    rf"(?:(?:(?P<m2>{_MONTH_RE})[a-z]*\.?\s+)?(?P<y2>(?:19|20)\d\d)|(?P<now>present|current|now|date))",
    re.IGNORECASE,
)
_STATED_YEARS = re.compile(
    r"(\d{1,2})\+?\s*(?:years?|yrs?)\b(?:\s+of)?(?:\s+[a-z/-]+){0,3}\s+experience", re.IGNORECASE
)
_REQUIRED_YEARS = re.compile(
    r"(\d{1,2})\s*(?:\+|or more|plus)?\s*(?:(?:-|–|to)\s*\d{1,2}\s*)?\+?\s*(?:years?|yrs?)\b",
    re.IGNORECASE,
)
# Dates right after these words are schooling, not work experience
_EDUCATION_CONTEXT = re.compile(
    r"universit|college|school|bachelor|master|\bb\.?s\b|\bm\.?s\b|degree|gpa|education|"
    r"certificat|b\.?tech|diploma",
    re.IGNORECASE,
)
_WORK_CONTEXT = re.compile(r"experience|employment|work history|career", re.IGNORECASE)
_SENIOR = re.compile(r"\b(senior|sr\.|lead|principal|staff)\b", re.IGNORECASE)
_JUNIOR = re.compile(
    r"\b(junior|jr\.|entry[- ]level|graduate|fresher|intern(?:ship)?)\b", re.IGNORECASE
)
_MAX_REQUIRED_YEARS = 15


def _month(name: str | None) -> int:
    return _MONTHS.index(name[:3].lower()) + 1 if name else 6


def _is_education_date(before: str) -> bool:
    """True when the nearest section cue before a date is about schooling, not work."""
    edu = [m.end() for m in _EDUCATION_CONTEXT.finditer(before)]
    work = [m.end() for m in _WORK_CONTEXT.finditer(before)]
    return bool(edu) and (not work or edu[-1] > work[-1])


def experience_years(resume_text: str, today: date | None = None) -> float:
    """
    Years of work experience in a resume: the union of dated work periods (education dates
    skipped, overlaps merged), or an explicit "N years of experience", whichever is larger.
    """
    today = today or date.today()
    now = today.year + (today.month - 1) / 12
    periods: list[tuple[float, float]] = []
    for m in _DATE_RANGE.finditer(resume_text or ""):
        if _is_education_date(resume_text[max(0, m.start() - 120) : m.start()]):
            continue
        start = int(m["y1"]) + (_month(m["m1"]) - 1) / 12
        end = now if m["now"] else int(m["y2"]) + (_month(m["m2"]) - 1) / 12
        if 0 <= end - start <= 45:
            periods.append((start, min(end, now)))

    total = 0.0
    current: tuple[float, float] | None = None
    for start, end in sorted(periods):
        if current and start <= current[1]:
            current = (current[0], max(current[1], end))
        else:
            if current:
                total += current[1] - current[0]
            current = (start, end)
    if current:
        total += current[1] - current[0]

    stated = [int(x) for x in _STATED_YEARS.findall(resume_text or "")]
    return round(max([total, *stated]), 1)


def required_years(job_text: str) -> int | None:
    """
    Minimum years a JD asks for. With several mentions ("5+ years, including at least 2 owning
    services") the largest lower bound is the real bar.
    """
    values = [int(m.group(1)) for m in _REQUIRED_YEARS.finditer(job_text or "")]
    values = [v for v in values if v <= _MAX_REQUIRED_YEARS]
    return max(values) if values else None


def seniority_level(text: str) -> str | None:
    """'senior' or 'junior' from title-like text, else None."""
    if _SENIOR.search(text or ""):
        return "senior"
    if _JUNIOR.search(text or ""):
        return "junior"
    return None


def seniority_fit(job_title: str, job_text: str, resume_text: str) -> dict[str, Any]:
    """
    Explanation-only comparison. status is 'meets', 'close' (at least half the years asked),
    'below', or 'unknown' when the JD gives no years.
    """
    need = required_years(job_text)
    have = experience_years(resume_text)
    status = "unknown"
    if need is not None:
        if have >= need:
            status = "meets"
        elif have >= 0.5 * need:
            status = "close"
        else:
            status = "below"
    return {
        "requiredYears": need,
        "resumeYears": have,
        "jobLevel": seniority_level(job_title),
        "status": status,
    }
