from __future__ import annotations

import re
from typing import Any

from ml.pipelines.intake.models import AtsHazard
from ml.scoring.ats_score import calculate_ats_v2, evaluate_resume_checks
from ml.scoring.curves import quantification_curve

STANDARD_ATS_FONTS = {
    "arial",
    "calibri",
    "times new roman",
    "times",
    "helvetica",
    "georgia",
    "verdana",
    "garamond",
    "trebuchet",
    "roboto",
    "open sans",
    "cambria",
}

# Whitelist for fast pattern matching (normalized alphanumeric lowercase)
STANDARD_ATS_FONT_PATTERNS = [
    # Classic ATS / System / Web
    r"^arial",
    r"^calibri",
    r"^times",
    r"^timesnewroman",
    r"^helvetica",
    r"^georgia",
    r"^verdana",
    r"^garamond",
    r"^trebuchet",
    r"^roboto",
    r"^opensans",
    r"^cambria",
    r"^courier",
    r"^tahoma",
    r"^palatino",
    r"^century",
    r"^bookman",
    # LaTeX / Scientific / Academic
    r"^cm",  # Computer Modern (CMR, CMSY, CMMI, etc.)
    r"^lm",  # Latin Modern (LMRoman, LMSans, etc.)
    r"^latinmodern",
    r"^computermodern",
    r"^sfrm",
    r"^msam",
    r"^msbm",
    r"^charter",  # Bitstream Charter
    r"^bitstream",
    # Modern UI & Developer Fonts
    r"^inter",
    r"^sourcesans",
    r"^sourcecodepro",
    r"^fira",
    r"^firacode",
    r"^jetbrains",
    r"^jetbrainsmono",
    r"^segoe",
    r"^segoeui",
    r"^dejavu",
    r"^helveticaneue",
]

ICON_FONT_PATTERNS = [
    r"^fontawesome",
    r"^glyphicons",
    r"^wingdings",
    r"^webdings",
    r"^fontello",
    r"^icomoon",
    r"^materialicons",
    r"^devicons",
]

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


def compute_coleman_liau(bullets: list[str]) -> float:
    """Computes Coleman-Liau grade level for a list of bullet points."""
    if not bullets:
        return 0.0
    total_words = sum(len(b.split()) for b in bullets)
    if total_words == 0:
        return 0.0
    total_letters = sum(sum(1 for c in b if c.isalpha()) for b in bullets)
    num_sentences = len(bullets)  # Each bullet is treated as a sentence unit
    L = 100.0 * (total_letters / total_words)
    S = 100.0 * (num_sentences / total_words)
    return round(0.0588 * L - 0.296 * S - 15.8, 1)

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

RAW_EMAIL_REGEX = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
RAW_PHONE_REGEX = re.compile(r"(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,5}\)?[-.\s]?\d{3}[-.\s]?\d{3,4}\b")


def is_ats_compliant_font(font_name: str) -> bool:
    """Checks if font matches known ATS or academic/LaTeX font families or is an icon font."""
    clean = re.sub(r"^[A-Z]{6}\+", "", font_name)
    clean = re.sub(
        r"[,\-_](Bold|Regular|Italic|Light|Medium|Black|Roman|Oblique|MT|PS).*",
        "",
        clean,
        flags=re.IGNORECASE,
    )
    norm = re.sub(r"[^a-z0-9]", "", clean.lower())
    if not norm:
        return True
    if any(re.search(pat, norm) for pat in ICON_FONT_PATTERNS):
        return True
    return any(re.search(pat, norm) for pat in STANDARD_ATS_FONT_PATTERNS)


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


class AtsAnalysisResult(tuple[float, list[AtsHazard]]):
    """
    A 2-tuple (ats_score, ats_hazards) that also exposes subscores,
    content_insights, rubric_version, and coverage.
    """

    def __new__(
        cls,
        ats_score: float,
        ats_hazards: list[AtsHazard],
        subscores: dict[str, float],
        content_insights: dict[str, Any] | None = None,
        rubric_version: str = "ats-v2",
        coverage: float = 1.0,
        unknown_checks: list[str] | None = None,
    ) -> AtsAnalysisResult:
        return super().__new__(cls, (ats_score, ats_hazards))

    def __init__(
        self,
        ats_score: float,
        ats_hazards: list[AtsHazard],
        subscores: dict[str, float],
        content_insights: dict[str, Any] | None = None,
        rubric_version: str = "ats-v2",
        coverage: float = 1.0,
        unknown_checks: list[str] | None = None,
    ) -> None:
        self.ats_score = ats_score
        self.ats_hazards = ats_hazards
        self.subscores = subscores
        self.content_insights = content_insights or {}
        self.rubric_version = rubric_version
        self.coverage = coverage
        self.unknown_checks = unknown_checks or []


def extract_content_insights(
    experience_items: list[Any] | None,
    skills: list[Any] | None,
    raw_text: str = "",
) -> dict[str, Any]:
    """
    Generates unscored editorial writing observations (Content Insights).
    These are purely qualitative tips for the candidate, completely separated
    from the ATS Readability parser diagnostic.
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
    cli_grade = compute_coleman_liau(bullets)

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
            "coleman_liau_grade": cli_grade,
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


def detect_ast_encoding_hazards(text: str) -> tuple[int, int, int]:
    """
    Scans text for AST encoding defects:
    - unmapped CID tokens: '(cid:123)'
    - Private Use Area (PUA) characters: 0xE000-0xF8FF, 0xF0000-0xFFFFD
    - Unexpanded ligature codepoints: 0xFB00-0xFB06
    """
    if not text:
        return 0, 0, 0
    cid_count = len(re.findall(r"\(cid:\d+\)", text))
    pua_count = sum(
        1 for c in text if 0xE000 <= ord(c) <= 0xF8FF or 0xF0000 <= ord(c) <= 0xFFFFD
    )
    ligature_count = sum(1 for c in text if 0xFB00 <= ord(c) <= 0xFB06)
    return cid_count, pua_count, ligature_count


def analyze_ats_hazards(
    is_ocr_required: bool,
    has_multi_column: bool,
    has_tables: bool,
    has_header_footer: bool,
    fonts_detected: set[str],
    sections_found: set[str],
    extractability_ratio: float = 1.0,
    contact: Any | None = None,
    skills: list[Any] | None = None,
    experience_items: list[Any] | None = None,
    education_items: list[Any] | None = None,
    experience_source: str = "experience",
    raw_text: str = "",
    is_contact_in_header_only: bool = False,
    extractor_agreement_ratio: float = 1.0,
    font_encoding_issues: list[str] | None = None,
) -> AtsAnalysisResult:
    """
    Evaluates document readability, layout safety, structure, contact, and hygiene
    according to the ResuMatch ATS Score Specification (ats-v2).
    """
    bullets: list[str] = []
    if experience_items:
        for item in experience_items:
            bullets.extend(getattr(item, "bullets", []))

    c_email = getattr(contact, "email", None) if contact else None
    c_phone = getattr(contact, "phone", None) if contact else None

    cid_count, pua_count, lig_count = detect_ast_encoding_hazards(raw_text)

    checks = evaluate_resume_checks(
        is_ocr_required=is_ocr_required,
        extractability_ratio=extractability_ratio,
        has_multi_column=has_multi_column,
        has_tables=has_tables,
        has_header_footer=has_header_footer,
        fonts_detected=fonts_detected,
        contact_email=c_email,
        contact_phone=c_phone,
        raw_text=raw_text,
        sections_found=sections_found,
        experience_count=len(experience_items or []),
        projects_count=1 if experience_source == "projects" else 0,
        education_count=len(education_items or []),
        skills_count=len(skills or []),
        bullets=bullets,
        pua_chars_count=pua_count,
        ligature_chars_count=lig_count,
        cid_tokens_count=cid_count,
        is_contact_in_header_only=is_contact_in_header_only,
        extractor_agreement_ratio=extractor_agreement_ratio,
        font_encoding_issues=font_encoding_issues,
    )

    ats_res = calculate_ats_v2(checks)

    hazards: list[AtsHazard] = []
    for h in ats_res.hazards:
        title_str = h["code"].replace("_", " ").title()
        desc_str = f"{h['evidence']} Remediation: {h['fix']}"
        hazards.append(
            AtsHazard(
                code=h["code"],
                title=title_str,
                description=desc_str,
                severity=h["severity"].upper(),
            )
        )

    content_insights = extract_content_insights(
        experience_items=experience_items,
        skills=skills,
        raw_text=raw_text,
    )

    return AtsAnalysisResult(
        ats_score=float(ats_res.score),
        ats_hazards=hazards,
        subscores=ats_res.subscores,
        content_insights=content_insights,
        rubric_version=ats_res.rubric_version,
        coverage=ats_res.coverage,
        unknown_checks=ats_res.unknown_checks,
    )
