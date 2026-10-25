"""
Phase 4C: Deterministic Content Analyzer for Resumes.
Detects missing standard sections, weak phrases, missing action verbs,
unquantified bullets, overly long bullets, and repeated opening verbs.
Provides exact character spans and quotes for every finding.
"""

from __future__ import annotations

import re

from ml.pipelines.improvements.models import ContentFinding

STANDARD_SECTIONS = [
    (
        "experience",
        re.compile(
            r"^\s*(?:(?:work|professional)\s+)?experience\b|^\s*employment\s+history\b",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "education",
        re.compile(
            r"^\s*(?:education|academic\s+background)\b",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
    (
        "skills",
        re.compile(
            r"^\s*(?:(?:technical|core)\s+)?(?:skills|competencies)\b",
            re.IGNORECASE | re.MULTILINE,
        ),
    ),
]

WEAK_PHRASES = [
    "responsible for",
    "duties included",
    "worked on",
    "assisted with",
    "helped with",
    "tasked with",
    "involved in",
    "handled",
]

# Curated list of strong resume action verbs (lowercase)
STRONG_ACTION_VERBS: set[str] = {
    "accelerated", "achieved", "administered", "advanced", "advised", "advocated",
    "allocated", "analyzed", "architected", "audited", "automated", "authored",
    "boosted", "briefed", "built", "centralized", "championed", "clarified",
    "coached", "collaborated", "compiled", "composed", "computed", "conceptualized",
    "configured", "consolidated", "constructed", "consulted", "converted",
    "coordinated", "crafted", "created", "customized", "debugged", "decreased",
    "defined", "delegated", "delivered", "demonstrated", "deployed", "designed",
    "developed", "devised", "diagnosed", "directed", "discovered", "dispatched",
    "documented", "drafted", "drove", "eliminated", "enabled", "enforced",
    "engineered", "enhanced", "established", "evaluated", "executed", "expanded",
    "expedited", "fabricated", "facilitated", "forecasted", "formulated", "founded",
    "generated", "governed", "guided", "halted", "headed", "identified",
    "implemented", "improved", "increased", "indexed", "initiated", "innovated",
    "inspected", "installed", "instituted", "instructed", "integrated", "intensified",
    "interviewed", "introduced", "invented", "investigated", "isolated", "launched",
    "led", "leveraged", "maintained", "managed", "mapped", "maximized", "measured",
    "mentored", "migrated", "minimized", "modeled", "modernized", "monitored",
    "negotiated", "obtained", "operated", "optimized", "orchestrated", "organized",
    "originated", "overhauled", "oversaw", "partnered", "performed", "pioneered",
    "planned", "positioned", "prepared", "prevented", "produced", "programmed",
    "projected", "promoted", "proposed", "prototyped", "published", "quantified",
    "re-engineered", "realigned", "rebuilt", "reclaimed", "reconciled", "redesigned",
    "reduced", "refined", "refactored", "regulated", "rehabilitated", "reinforced",
    "remodeled", "reorganized", "repaired", "replaced", "reported", "researched",
    "resolved", "restructured", "retrieved", "revamped", "reviewed", "revitalized",
    "routed", "saved", "scaled", "scheduled", "screened", "scrutinized", "secured",
    "selected", "separated", "simplified", "simulated", "slashed", "solicited",
    "solved", "spearheaded", "standardized", "started", "steered", "streamlined",
    "strengthened", "structured", "superseded", "supervised", "supplied", "supported",
    "surpassed", "surveyed", "synthesized", "systematized", "tabulated", "targeted",
    "tested", "tracked", "trained", "transformed", "translated", "triaged", "trimmed",
    "troubleshot", "unified", "unlocked", "updated", "upgraded", "utilized",
    "validated", "verified", "visualized", "won", "wrote", "yielded",
}

BULLET_LINE_REGEX = re.compile(
    r"^(?P<indent>\s*)(?P<bullet>[\u2022\u25E6\u2043\u2219\u2013\u2014\-\*]|\d+[\.\)])\s+(?P<content>.+)$",
    re.UNICODE,
)


def analyze_content(raw_text: str) -> list[ContentFinding]:
    """
    Performs deterministic content checks on rawText and returns prioritized findings
    with exact character offsets.
    """
    findings: list[ContentFinding] = []

    if not raw_text or not raw_text.strip():
        return findings

    # 1. Check Missing Standard Sections
    for sec_name, pattern in STANDARD_SECTIONS:
        if not re.search(pattern, raw_text):
            findings.append(
                ContentFinding(
                    type="MISSING_SECTION",
                    severity="HIGH",
                    message=f"Missing standard '{sec_name.capitalize()}' section header.",
                    startChar=0,
                    endChar=0,
                    quote="",
                )
            )

    # 2. Check Weak Passive Phrases with exact offsets
    for phrase in WEAK_PHRASES:
        phrase_pattern = rf"\b{re.escape(phrase)}\b"
        for phrase_match in re.finditer(phrase_pattern, raw_text, re.IGNORECASE):
            start = phrase_match.start()
            end = phrase_match.end()
            findings.append(
                ContentFinding(
                    type="WEAK_PHRASE",
                    severity="MEDIUM",
                    message=(
                        f"Weak passive phrase '{raw_text[start:end]}' found; "
                        "replace with a decisive action verb and quantifiable result."
                    ),
                    startChar=start,
                    endChar=end,
                    quote=raw_text[start:end],
                )
            )

    # 3. Analyze Bullet Lines for Action Verbs, Metrics, Length, and Repeated Verbs
    lines_with_offsets: list[tuple[int, int, str]] = []
    current_pos = 0
    for line in raw_text.splitlines(keepends=True):
        line_start = current_pos
        line_end = line_start + len(line.rstrip("\r\n"))
        lines_with_offsets.append((line_start, line_end, line.rstrip("\r\n")))
        current_pos += len(line)

    opening_verb_occurrences: dict[str, list[tuple[int, int, str]]] = {}

    for l_start, _l_end, line_text in lines_with_offsets:
        bullet_match = BULLET_LINE_REGEX.match(line_text)
        if not bullet_match:
            continue

        content_raw = bullet_match.group("content").strip()
        if not content_raw:
            continue

        # Compute exact content offsets inside rawText
        content_offset_in_line = line_text.find(content_raw)
        b_start = l_start + content_offset_in_line
        b_end = b_start + len(content_raw)
        b_quote = raw_text[b_start:b_end]

        # Check a: Overly Long Bullet (> 200 chars)
        if len(content_raw) > 200:
            findings.append(
                ContentFinding(
                    type="OVERLY_LONG_BULLET",
                    severity="LOW",
                    message=(
                        f"Bullet point exceeds 200 characters ({len(content_raw)} chars); "
                        "split or condense into a concise STAR accomplishment."
                    ),
                    startChar=b_start,
                    endChar=b_end,
                    quote=b_quote,
                )
            )

        # Check b: Opening Action Verb
        words = re.split(r"[\s\.,;:()\[\]]+", content_raw)
        first_word = words[0].strip().lower() if words else ""
        clean_first_word = re.sub(r"[^\w-]", "", first_word)

        if clean_first_word and clean_first_word not in STRONG_ACTION_VERBS:
            findings.append(
                ContentFinding(
                    type="NO_ACTION_VERB",
                    severity="MEDIUM",
                    message=(
                        f"Bullet does not begin with a recognized action verb "
                        f"(begins with '{words[0]}')."
                    ),
                    startChar=b_start,
                    endChar=b_end,
                    quote=b_quote,
                )
            )
        elif clean_first_word in STRONG_ACTION_VERBS:
            if clean_first_word not in opening_verb_occurrences:
                opening_verb_occurrences[clean_first_word] = []
            opening_verb_occurrences[clean_first_word].append((b_start, b_end, b_quote))

        # Check c: Numbers or Metrics
        if not re.search(r"\d|%", content_raw):
            findings.append(
                ContentFinding(
                    type="NO_METRIC_OR_NUMBER",
                    severity="LOW",
                    message=(
                        "Bullet lacks measurable numbers or percentages "
                        "(e.g. %, $, latency, scale)."
                    ),
                    startChar=b_start,
                    endChar=b_end,
                    quote=b_quote,
                )
            )

    # 4. Check Repeated Opening Verbs (if used >= 2 times, flag subsequent bullets)
    for verb, occurrences in opening_verb_occurrences.items():
        if len(occurrences) >= 2:
            for b_start, b_end, b_quote in occurrences[1:]:
                findings.append(
                    ContentFinding(
                        type="REPEATED_OPENING_VERB",
                        severity="LOW",
                        message=(
                            f"Action verb '{verb}' is repeated across multiple bullets; "
                            "diversify your vocabulary to highlight different competencies."
                        ),
                        startChar=b_start,
                        endChar=b_end,
                        quote=b_quote,
                    )
                )

    # Sort findings: HIGH -> MEDIUM -> LOW, then startChar
    sev_rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    findings.sort(key=lambda f: (sev_rank.get(f.severity, 3), f.startChar))

    return findings
