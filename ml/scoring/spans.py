"""Verification of Call 1 (extraction) output against the source text.

The model only returns spans. Code decides what survives: a fact is kept only if
`canonical[start:end] == text`, or if one whitespace-tolerant search finds the text
exactly once (offsets are then corrected). Anything else is dropped and counted;
nothing here raises on bad model output.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any

_MONTHS = (
    "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|"
    "august|september|october|november|december"
)
_APOS_YEAR = re.compile(r"\b(" + _MONTHS + r")\.?\s*['\u2019`]\s*(\d{2})\b", re.I)
_MON_DASH_YY = re.compile(r"\b(" + _MONTHS + r")\s*-\s*(\d{2})\b(?!\d)", re.I)
_DOTTED_DATE = re.compile(r"\b(\d{1,2})\.(\d{1,2})\.((?:19|20)\d{2})\b")
_TILL_DATE = re.compile(
    r"\b(?:till\s+date|till\s+now|till\s+today|to\s+date|till\s+present|currently\s+working|"
    r"currently\s+employed|ongoing|continuing)\b",
    re.I,
)
ZERO_WIDTH = re.compile("[​‌‍⁠﻿]")
KINDS = {
    "skill_mention", "role_header", "date_range", "education_entry", "credential_mention",
    "credential_date", "years_claim", "jd_title", "jd_requirement", "jd_priority_cue",
    "jd_years_phrase", "jd_alternative_path",
}
ALLOWED_KEYS = {"fact_id", "doc", "kind", "start", "end", "text", "links"}


def canonicalize(text: str) -> tuple[str, bool]:
    """Canonical form every span refers to: NFC, no zero-width characters, LF line endings, no
    trailing spaces, one newline between lines. Returns (text, had_hidden_chars); only
    zero-width characters count as hidden text, formatting noise does not."""
    nfc = unicodedata.normalize("NFC", text or "")
    hidden = ZERO_WIDTH.search(nfc) is not None
    clean = ZERO_WIDTH.sub("", nfc).replace("\r\n", "\n").replace("\r", "\n")
    clean = "\n".join(line.rstrip() for line in clean.split("\n"))
    return _indian_dates(re.sub(r"\n{2,}", "\n", clean)), hidden


def _two_digit_year(yy: str) -> str:
    return ("20" if int(yy) <= 40 else "19") + yy


def _indian_dates(text: str) -> str:
    """Apr'19 and Apr-19 become Apr 2019, 01.04.2019 becomes 01/04/2019, and "till date" or
    "ongoing" becomes Present, so one date reader serves every common Indian resume style."""
    text = _APOS_YEAR.sub(lambda m: f"{m.group(1)} {_two_digit_year(m.group(2))}", text)
    text = _MON_DASH_YY.sub(lambda m: f"{m.group(1)} {_two_digit_year(m.group(2))}", text)
    text = _DOTTED_DATE.sub(lambda m: f"{m.group(1)}/{m.group(2)}/{m.group(3)}", text)
    return _TILL_DATE.sub("Present", text)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class VerifiedFact:
    fact_id: str
    doc: str
    kind: str
    start: int
    end: int
    text: str
    corrected: bool = False


@dataclass
class VerificationReport:
    facts: list[VerifiedFact] = field(default_factory=list)
    dropped: dict[str, int] = field(default_factory=dict)
    hidden_text: dict[str, bool] = field(default_factory=dict)

    def _drop(self, reason: str) -> None:
        self.dropped[reason] = self.dropped.get(reason, 0) + 1


def _find_once(haystack: str, needle: str) -> int | None:
    pattern = r"\s+".join(re.escape(part) for part in needle.split())
    found = [m.start() for m in re.finditer(pattern, haystack)]
    return found[0] if len(found) == 1 else None


def verify_facts(raw: Any, resume_text: str, jd_text: str) -> VerificationReport:
    """Verify an extraction payload. Never raises; unusable input yields an empty report."""
    report = VerificationReport()
    docs: dict[str, str] = {}
    for name, text in (("resume", resume_text), ("jd", jd_text)):
        docs[name], report.hidden_text[name] = canonicalize(text)
    facts = raw.get("facts") if isinstance(raw, dict) else None
    if not isinstance(facts, list):
        report._drop("malformed_payload")
        return report
    seen: set[str] = set()
    for item in facts[:600]:
        if not isinstance(item, dict) or set(item) - ALLOWED_KEYS:
            report._drop("malformed_or_judgment_field")  # judgment fields are forbidden
            continue
        try:
            fid, doc, kind = str(item["fact_id"]), item["doc"], item["kind"]
            start, end, text = int(item["start"]), int(item["end"]), str(item["text"])
        except (KeyError, TypeError, ValueError):
            report._drop("malformed_fact")
            continue
        if doc not in docs or kind not in KINDS or not text.strip() or len(text) > 500 or fid in seen:
            report._drop("invalid_value")
            continue
        seen.add(fid)
        source = docs[doc]
        if 0 <= start < end <= len(source) and source[start:end] == text:
            report.facts.append(VerifiedFact(fid, doc, kind, start, end, text))
            continue

        # Windowed local search (+/- 40 chars) to recover from minor Unicode code-unit/code-point shifts or whitespace shifts
        window_start = max(0, start - 40)
        window_end = min(len(source), end + 40)
        window = source[window_start:window_end]
        pattern = re.compile(r"\s+".join(re.escape(p) for p in text.split()))
        local_matches = list(pattern.finditer(window))
        if len(local_matches) == 1:
            m = local_matches[0]
            pos = window_start + m.start()
            end_pos = window_start + m.end()
            report.facts.append(
                VerifiedFact(fid, doc, kind, pos, end_pos, source[pos:end_pos], corrected=True)
            )
            continue

        pos = _find_once(source, text)
        if pos is None:
            report._drop("text_not_found_or_ambiguous")
            continue
        match = re.compile(r"\s+".join(re.escape(p) for p in text.split())).match(source, pos)
        end_pos = match.end() if match else pos + len(text)
        report.facts.append(
            VerifiedFact(fid, doc, kind, pos, end_pos, source[pos:end_pos], corrected=True)
        )
    return report
