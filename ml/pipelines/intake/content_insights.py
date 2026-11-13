"""Unscored writing observations (content insights) for a parsed resume.

These are editorial tips only (measurable outcomes, action verbs, bullet length,
skills shown in context). They never produce a score.
"""

from __future__ import annotations

import re
from typing import Any

from ml.scoring.curves import quantification_curve

STRONG_ACTION_VERBS = {
    "accelerated",
    "accomplished",
    "achieved",
    "acquired",
    "acted",
    "adapted",
    "administered",
    "advanced",
    "advised",
    "allocated",
    "analyzed",
    "architected",
    "assembled",
    "assessed",
    "attained",
    "audited",
    "authored",
    "automated",
    "balanced",
    "boosted",
    "briefed",
    "budgeted",
    "built",
    "calculated",
    "captured",
    "championed",
    "clarified",
    "coached",
    "collaborated",
    "collected",
    "compiled",
    "composed",
    "computed",
    "conceived",
    "conducted",
    "configured",
    "constructed",
    "consulted",
    "controlled",
    "converted",
    "coordinated",
    "counseled",
    "crafted",
    "created",
    "cultivated",
    "customized",
    "debugged",
    "decreased",
    "defined",
    "delegated",
    "delivered",
    "demonstrated",
    "deployed",
    "designed",
    "determined",
    "developed",
    "devised",
    "diagnosed",
    "directed",
    "discovered",
    "dispatched",
    "distributed",
    "documented",
    "doubled",
    "drafted",
    "drove",
    "earned",
    "edited",
    "eliminated",
    "enabled",
    "enacted",
    "engineered",
    "enhanced",
    "enlarged",
    "enlisted",
    "ensured",
    "established",
    "estimated",
    "evaluated",
    "examined",
    "executed",
    "expanded",
    "expedited",
    "experimented",
    "explained",
    "explored",
    "facilitated",
    "finalized",
    "financed",
    "focused",
    "forecasted",
    "formulated",
    "fostered",
    "founded",
    "gathered",
    "generated",
    "governed",
    "guided",
    "halted",
    "handled",
    "headed",
    "heightened",
    "identified",
    "illuminated",
    "implemented",
    "improved",
    "improvised",
    "increased",
    "indexed",
    "influenced",
    "initiated",
    "innovated",
    "inspected",
    "inspired",
    "installed",
    "instituted",
    "instructed",
    "integrated",
    "intensified",
    "interpreted",
    "interviewed",
    "introduced",
    "invented",
    "investigated",
    "isolated",
    "launched",
    "lead",
    "led",
    "leveraged",
    "liaised",
    "maintained",
    "managed",
    "mapped",
    "marketed",
    "maximized",
    "measured",
    "mediated",
    "mentored",
    "merged",
    "minimized",
    "modeled",
    "moderated",
    "modernized",
    "monitored",
    "motivated",
    "navigated",
    "negotiated",
    "obtained",
    "operated",
    "optimized",
    "orchestrated",
    "organized",
    "originated",
    "outperformed",
    "overhauled",
    "oversaw",
    "participated",
    "partnered",
    "performed",
    "persuaded",
    "piloted",
    "pioneered",
    "planned",
    "prepared",
    "presented",
    "prioritized",
    "produced",
    "programmed",
    "projected",
    "promoted",
    "proposed",
    "published",
    "purchased",
    "quantified",
    "raised",
    "recommended",
    "reconciled",
    "recruited",
    "redesigned",
    "reduced",
    "refined",
    "reformed",
    "regained",
    "regulated",
    "reinforced",
    "remodeled",
    "reorganized",
    "repaired",
    "replaced",
    "researched",
    "resolved",
    "restructured",
    "revamped",
    "reviewed",
    "revitalized",
    "routed",
    "saved",
    "scaled",
    "scheduled",
    "secured",
    "selected",
    "served",
    "shaped",
    "simplified",
    "slashed",
    "solidified",
    "solved",
    "spearheaded",
    "standardized",
    "started",
    "steered",
    "streamlined",
    "strengthened",
    "structured",
    "succeeded",
    "supervised",
    "supplied",
    "supported",
    "surpassed",
    "surveyed",
    "synthesized",
    "systematized",
    "targeted",
    "taught",
    "tested",
    "tracked",
    "trained",
    "transformed",
    "transitioned",
    "translated",
    "troubleshot",
    "unified",
    "unraveled",
    "updated",
    "upgraded",
    "utilized",
    "validated",
    "verified",
    "visualized",
    "won",
    "wrote",
}

PASSIVE_VOICE_REGEX = re.compile(
    r"\b(?:am|is|are|was|were|be|been|being)\b\s+(?:\w+ly\s+)?(?:\w+(?:ed|en)|built|made|done|given|taken|shown|run|written|chosen|driven|known|seen|sent|kept|held|led|found|set|put|begun|grown|drawn)\b",
    re.IGNORECASE,
)

FILLER_PHRASES_REGEX = re.compile(
    r"\b(?:various|multiple|several|numerous|etc\.?|and more|helped to|team player|hard[- ]working|detail[- ]oriented|results[- ]driven)\b",
    re.IGNORECASE,
)

WEAK_OPENER_PATTERNS = [
    re.compile(r"^[^a-zA-Z]*(?:assisted|helped)\b(?:\s+(?:with|in|to))?", re.IGNORECASE),
    re.compile(r"^[^a-zA-Z]*responsible\s+for\b", re.IGNORECASE),
    re.compile(r"^[^a-zA-Z]*worked\s+(?:on|with)\b", re.IGNORECASE),
    re.compile(r"^[^a-zA-Z]*involved\s+in\b", re.IGNORECASE),
    re.compile(r"^[^a-zA-Z]*tasked\s+with\b", re.IGNORECASE),
    re.compile(r"^[^a-zA-Z]*duties\s+(?:included|were)\b", re.IGNORECASE),
]

METRIC_REGEX = re.compile(
    r"(?:"
    r"\b\d+(?:\.\d+)?%\b|"  # 40%, 1.9%
    r"\b\d+(?:\.\d+)?x\b|"  # 2x, 10x
    r"[\$€£₹]\s*\d+(?:,\d{3})*(?:\.\d+)?(?:\s*[kKmMbB])?\b|"  # $50k, $1.2M
    r"\b\d+(?:\.\d+)?\s*(?:k|m|b|million|billion|thousand)\b|"  # 500k, 1 million
    r"\b\d+(?:\.\d+)?\s*(?:users|clients|customers|engineers|members|developers|people|nodes|clusters|services|rps|qps|ms|seconds|minutes|hours|days|weeks|months|years|gb|tb|mb|kb)\b|"
    r"\b\d+-(?:member|person|engineer)\b|"
    r"\b[1-9]\d{1,4}\b"  # numbers like 40, 100, 5000 (excluding 4-digit years)
    r")",
    re.IGNORECASE,
)



def has_quantified_metric(text: str) -> bool:
    """Detects whether text includes measurable business/technical metrics."""
    matches = METRIC_REGEX.findall(text)
    for m in matches:
        stripped = m.strip()
        # If it's a 4-digit calendar year (1980 - 2035), do not count as a performance metric
        if stripped.isdigit() and 1980 <= int(stripped) <= 2035:
            continue
        return True
    return False


def starts_with_action_verb(text: str) -> bool:
    """Detects if bullet begins with a strong active verb."""
    cleaned = re.sub(r"^[^a-zA-Z]+", "", text).strip()
    if not cleaned:
        return False
    first_word = cleaned.split()[0].lower()
    return first_word in STRONG_ACTION_VERBS


def extract_content_insights(
    experience_items: list[Any] | None,
    skills: list[Any] | None,
    raw_text: str = "",
) -> dict[str, Any]:
    """
    Generates unscored editorial writing observations (Content Insights).
    These are purely qualitative tips for the candidate, completely separated
    from any score.
    """
    bullets: list[str] = []
    for item in experience_items or []:
        bullets.extend(getattr(item, "bullets", []) or [])

    if not bullets and raw_text:
        lines = [ln.strip() for ln in raw_text.split("\n") if ln.strip()]
        bullets = [
            ln for ln in lines if ln.startswith(("-", "*", "•", "–")) or re.match(r"^\d+\.\s+", ln)
        ]

    total_bullets = len(bullets)
    quantified_bullets = [b for b in bullets if has_quantified_metric(b)]
    action_verb_bullets = [b for b in bullets if starts_with_action_verb(b)]

    # Collect leading verbs for variety check
    leading_verbs: list[str] = []
    for b in bullets:
        cleaned = re.sub(r"^[^a-zA-Z]+", "", b).strip()
        if cleaned:
            leading_verbs.append(cleaned.split()[0].title())

    verb_counts: dict[str, int] = {}
    for v in leading_verbs:
        verb_counts[v] = verb_counts.get(v, 0) + 1
    repeated_verbs = [v for v, count in verb_counts.items() if count >= 3]

    # Per-role verb repetition (role-scoped)
    role_repeated_verbs: list[str] = []
    for item in experience_items or []:
        item_bullets = getattr(item, "bullets", []) or []
        r_verbs: list[str] = []
        for b in item_bullets:
            cleaned = re.sub(r"^[^a-zA-Z]+", "", b).strip()
            if cleaned:
                r_verbs.append(cleaned.split()[0].title())
        r_counts: dict[str, int] = {}
        for rv in r_verbs:
            r_counts[rv] = r_counts.get(rv, 0) + 1
        for rv, cnt in r_counts.items():
            if cnt >= 3 and rv not in role_repeated_verbs:
                role_repeated_verbs.append(rv)

    # Disentangled Weak Openers vs Passive Voice vs Filler Phrases
    weak_openers_found: list[str] = []
    for b in bullets:
        for pat in WEAK_OPENER_PATTERNS:
            m = pat.search(b)
            if m:
                snippet = m.group(0).strip().lstrip("•-* ")
                if snippet and snippet not in weak_openers_found:
                    weak_openers_found.append(snippet)

    passive_voice_detected = bool(PASSIVE_VOICE_REGEX.search(raw_text)) if raw_text else False
    filler_phrases_found = [
        m.group(0) for m in FILLER_PHRASES_REGEX.finditer(raw_text)
    ] if raw_text else []

    # Bullets length check: micro-bullets (< 5 words), run-on bullets (> 35 words or > 300 chars)
    word_counts = [len(b.split()) for b in bullets]
    micro_bullets = [b for b, wc in zip(bullets, word_counts) if wc < 5]
    run_on_bullets = [b for b, wc in zip(bullets, word_counts) if wc > 35 or len(b) > 300]

    # Contextual skills in bullets
    skills_declared = [getattr(s, "name", str(s)).lower() for s in (skills or [])]
    contextual_skills = []
    for s_name in skills_declared:
        if any(re.search(rf"\b{re.escape(s_name)}\b", b, re.IGNORECASE) for b in bullets):
            contextual_skills.append(s_name)

    quant_ratio = (len(quantified_bullets) / total_bullets) if total_bullets > 0 else 0.0
    verb_ratio = (len(action_verb_bullets) / total_bullets) if total_bullets > 0 else 0.0
    calibrated_saturation_score = round(quantification_curve(quant_ratio) * 100, 1)

    return {
        "measurable_outcomes": {
            "quantified_bullets_count": len(quantified_bullets),
            "total_bullets_count": total_bullets,
            "quantification_ratio": round(quant_ratio, 2),
            "calibrated_saturation_score": calibrated_saturation_score,
            "observation": (
                f"{len(quantified_bullets)} of {total_bullets} bullets contain measurable "
                "outcomes (%, $, scale, metrics)."
                if total_bullets > 0
                else "No structured bullet points found to evaluate measurable outcomes."
            ),
        },
        "action_verbs": {
            "strong_verbs_count": len(action_verb_bullets),
            "total_verbs_count": total_bullets,
            "strong_verb_ratio": round(verb_ratio, 2),
            "repeated_verbs": repeated_verbs,
            "role_repeated_verbs": role_repeated_verbs,
            "weak_phrases_detected": weak_openers_found,
            "passive_voice_detected": passive_voice_detected,
            "filler_phrases_detected": list(set(filler_phrases_found)),
            "observation": (
                f"{len(action_verb_bullets)} of {total_bullets} bullets begin with dynamic "
                "action verbs."
                + (
                    f" Repeated verbs to consider varying: {', '.join(repeated_verbs)}."
                    if repeated_verbs
                    else ""
                )
            ),
        },
        "bullet_brevity": {
            "concise_count": total_bullets - len(run_on_bullets),
            "long_bullets_count": len(run_on_bullets),
            "micro_bullets_count": len(micro_bullets),
            "observation": (
                f"{len(run_on_bullets)} bullets exceed standard length (>35 words). Aim for concise 12-28 word "
                "accomplishment statements."
                if run_on_bullets
                else "All bullet points adhere to concise length guidelines."
            ),
        },
        "skills_in_context": {
            "declared_count": len(skills_declared),
            "contextual_count": len(contextual_skills),
            "sample_contextual_skills": contextual_skills[:6],
            "observation": (
                f"{len(contextual_skills)} declared technical skills are demonstrated directly "
                "within accomplishment bullets."
                if contextual_skills
                else (
                    "Consider demonstrating key technical tools directly inside your "
                    "bullet descriptions."
                )
            ),
        },
    }

