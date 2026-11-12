"""
ResuMatch AI: ATS Score Engine (Rubric v2)
Fully deterministic, rule-based ATS parseability & structure audit.
Implements dynamic check renormalization and coverage calculation per docs/ATS_READABILITY_SPECIFICATION.md.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Literal

RUBRIC_VERSION = "ats-v2"

CheckStatus = Literal["passed", "failed", "unknown"]
SeverityLevel = Literal["critical", "high", "medium", "low"]


@dataclass
class CheckDeduction:
    code: str
    severity: SeverityLevel
    points_lost: float
    evidence: str
    fix: str


@dataclass
class Check:
    id: str
    category: Literal[
        "parse_integrity",
        "layout_safety",
        "structure",
        "contact",
        "content_hygiene",
    ]
    max_points: float
    earned_points: float
    status: CheckStatus
    deductions: list[CheckDeduction] = field(default_factory=list)


@dataclass
class ATSResult:
    score: int
    rubric_version: str
    coverage: float
    subscores: dict[str, float]
    hazards: list[dict[str, Any]]
    unknown_checks: list[str]
    is_incomplete: bool


def calculate_ats_v2(checks: list[Check]) -> ATSResult:
    """
    Computes ATS Score (ats-v2) using evaluated checks.
    Unknown checks are excluded from the denominator and the score is renormalized.
    """
    evaluated = [c for c in checks if c.status != "unknown"]
    unknown_ids = [c.id for c in checks if c.status == "unknown"]

    total_possible_max = sum(c.max_points for c in checks)
    eval_max = sum(c.max_points for c in evaluated)
    earned_total = sum(c.earned_points for c in evaluated)

    if total_possible_max > 0:
        coverage = round(eval_max / total_possible_max, 2)
    else:
        coverage = 1.0

    if eval_max > 0:
        normalized_score = round(100.0 * (earned_total / eval_max))
    else:
        normalized_score = 100

    normalized_score = max(0, min(100, normalized_score))

    # Apply non-compensatory 70 cap if critical contact details are trapped in header/footer margins
    has_trapped_contact = any(
        d.code in ("CONTACT_IN_HEADER_FOOTER", "CONTACT_TRAPPED_MARGIN")
        for c in evaluated
        for d in c.deductions
    )
    if has_trapped_contact:
        normalized_score = min(normalized_score, 70)

    # Calculate per-category subscores normalized to their category max
    categories = [
        "parse_integrity",
        "layout_safety",
        "structure",
        "contact",
        "content_hygiene",
    ]
    subscores: dict[str, float] = {}

    for cat in categories:
        cat_checks = [c for c in evaluated if c.category == cat]
        cat_max = sum(c.max_points for c in cat_checks)
        cat_earned = sum(c.earned_points for c in cat_checks)
        if cat_max > 0:
            subscores[cat] = round(cat_earned, 1)
        else:
            subscores[cat] = 0.0

    # Retain backward-compatible readability_score key
    subscores["readability_score"] = float(normalized_score)

    # Collect all hazard deductions with evidence and fixes
    hazards: list[dict[str, Any]] = []
    for c in evaluated:
        for d in c.deductions:
            hazards.append(
                {
                    "id": c.id,
                    "code": d.code,
                    "severity": d.severity,
                    "points_lost": d.points_lost,
                    "evidence": d.evidence,
                    "fix": d.fix,
                }
            )

    return ATSResult(
        score=normalized_score,
        rubric_version=RUBRIC_VERSION,
        coverage=coverage,
        subscores=subscores,
        hazards=hazards,
        unknown_checks=unknown_ids,
        is_incomplete=coverage < 0.6,
    )


# Helper function to evaluate standard resume checks
def evaluate_resume_checks(
    *,
    is_ocr_required: bool,
    extractability_ratio: float = 1.0,
    has_multi_column: bool,
    has_tables: bool,
    has_header_footer: bool,
    fonts_detected: set[str] | None = None,
    contact_email: str | None = None,
    contact_phone: str | None = None,
    raw_text: str = "",
    sections_found: set[str] | None = None,
    dates_found_count: int = 0,
    experience_count: int = 0,
    projects_count: int = 0,
    education_count: int = 0,
    skills_count: int = 0,
    bullets: list[str] | None = None,
    check_links_status: CheckStatus = "unknown",  # by default link check is optional/unknown
    pua_chars_count: int = 0,
    ligature_chars_count: int = 0,
    cid_tokens_count: int = 0,
    is_contact_in_header_only: bool = False,
    extractor_agreement_ratio: float = 1.0,
    font_encoding_issues: list[str] | None = None,
) -> list[Check]:
    """
    Assembles the 100-point check suite:
    - parse_integrity: 40 pts
    - layout_safety: 20 pts
    - structure: 20 pts
    - contact: 10 pts
    - content_hygiene: 10 pts
    """
    checks: list[Check] = []
    sections = {s.lower() for s in (sections_found or set())}
    bullet_list = bullets or []

    # If explicit bullets were not extracted, scan raw text for bullet lines or sentences
    if not bullet_list and raw_text:
        lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
        detected_bullets = [
            line for line in lines if line.startswith(("-", "•", "*", "–")) or len(line) > 10
        ]
        if detected_bullets:
            bullet_list = detected_bullets

    # -------------------------------------------------------------------------
    # 1. PARSE INTEGRITY (40 pts)
    #    - Text Layer & OCR Integrity (30 pts)
    #    - Visible-in-raw but missed extraction (10 pts)
    # -------------------------------------------------------------------------
    parse_deductions: list[CheckDeduction] = []
    parse_earned = 30.0

    if is_ocr_required:
        parse_earned = 0.0
        parse_deductions.append(
            CheckDeduction(
                code="OCR_REQUIRED",
                severity="critical",
                points_lost=30.0,
                evidence="Scanned image-only PDF lacking digital text layer.",
                fix="Export the resume as a standard text-based PDF or DOCX file directly from Word or Google Docs.",
            )
        )
    elif extractability_ratio < 0.85:
        loss = 15.0
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="DEGRADED_TEXT_LAYER",
                severity="high",
                points_lost=loss,
                evidence=f"Text extractability ratio is {extractability_ratio:.2f} (below 0.85 threshold).",
                fix="Re-export the document using standard system fonts without font subsetting or flattening.",
            )
        )

    if cid_tokens_count > 0:
        loss = min(15.0, 5.0 + cid_tokens_count * 0.5)
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="CID_FONT_UNMAPPED",
                severity="critical" if cid_tokens_count > 10 else "high",
                points_lost=loss,
                evidence=f"Detected {cid_tokens_count} unmapped CID font tokens (e.g. (cid:123)) indicating missing ToUnicode CMap.",
                fix="Re-export PDF with standard embedded Unicode-mapped fonts (disable custom CID subsets).",
            )
        )

    if pua_chars_count > 0:
        loss = min(10.0, 3.0 + pua_chars_count * 0.2)
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="PUA_CHARACTERS_DETECTED",
                severity="medium",
                points_lost=loss,
                evidence=f"Found {pua_chars_count} Private Use Area (PUA) characters (0xE000-0xF8FF) that ATS cannot index.",
                fix="Replace custom symbol or icon fonts with standard text characters and bullet glyphs.",
            )
        )

    if ligature_chars_count > 0:
        loss = min(5.0, ligature_chars_count * 0.5)
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="UNEXPANDED_LIGATURES",
                severity="low",
                points_lost=loss,
                evidence=f"Found {ligature_chars_count} unexpanded ligature codepoints (fi/fl/ffi) which may break keyword matching.",
                fix="Disable font ligatures in your word processor export settings.",
            )
        )

    if font_encoding_issues:
        loss = min(15.0, len(font_encoding_issues) * 5.0)
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="FONT_ENCODING_HAZARD",
                severity="high",
                points_lost=loss,
                evidence=f"Font encoding hazards detected: {', '.join(font_encoding_issues[:3])}.",
                fix="Use standard TrueType or OpenType system fonts with embedded ToUnicode CMaps.",
            )
        )

    if extractor_agreement_ratio < 0.75:
        loss = 10.0
        parse_earned = max(0.0, parse_earned - loss)
        parse_deductions.append(
            CheckDeduction(
                code="EXTRACTOR_DISAGREEMENT",
                severity="high",
                points_lost=loss,
                evidence=f"Dual-extractor layout token agreement is {extractor_agreement_ratio:.0%} (below 75% threshold).",
                fix="Simplify layout to a linear single column to prevent disparate parser reading orders.",
            )
        )

    checks.append(
        Check(
            id="text_layer_integrity",
            category="parse_integrity",
            max_points=30.0,
            earned_points=parse_earned,
            status="failed" if parse_deductions else "passed",
            deductions=parse_deductions,
        )
    )

    # Missing parsed field when visible in raw text
    entity_deductions: list[CheckDeduction] = []
    entity_earned = 10.0

    email_regex = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+")
    raw_has_email = bool(email_regex.search(raw_text))
    if raw_has_email and not contact_email:
        loss = 6.0
        entity_earned = max(0.0, entity_earned - loss)
        raw_match = email_regex.search(raw_text)
        snippet = raw_match.group(0) if raw_match else "email"
        entity_deductions.append(
            CheckDeduction(
                code="EXTRACTION_MISSED_EMAIL",
                severity="high",
                points_lost=loss,
                evidence=f"Email pattern '{snippet}' found in raw text but missing in parsed profile.",
                fix="Place email clearly on its own line in the top contact section without icons or special symbols.",
            )
        )

    phone_regex = re.compile(r"(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
    raw_has_phone = bool(phone_regex.search(raw_text))
    if raw_has_phone and not contact_phone:
        loss = 4.0
        entity_earned = max(0.0, entity_earned - loss)
        phone_match = phone_regex.search(raw_text)
        snippet = phone_match.group(0) if phone_match else "phone"
        entity_deductions.append(
            CheckDeduction(
                code="EXTRACTION_MISSED_PHONE",
                severity="medium",
                points_lost=loss,
                evidence=f"Phone pattern '{snippet}' visible in raw text but missing in parsed profile.",
                fix="Format phone number with standard separators (e.g. 555-123-4567) in header contact info.",
            )
        )

    checks.append(
        Check(
            id="extraction_completeness",
            category="parse_integrity",
            max_points=10.0,
            earned_points=entity_earned,
            status="failed" if entity_deductions else "passed",
            deductions=entity_deductions,
        )
    )

    # -------------------------------------------------------------------------
    # 2. LAYOUT SAFETY (20 pts)
    #    - Multi-column (20 pts)
    #    - Tables (5 pts)
    #    - Header / Footer margins (5 pts)
    # -------------------------------------------------------------------------
    layout_deductions: list[CheckDeduction] = []
    layout_earned = 20.0

    if has_multi_column:
        layout_earned -= 20.0
        layout_deductions.append(
            CheckDeduction(
                code="MULTI_COLUMN_LAYOUT",
                severity="high",
                points_lost=20.0,
                evidence="Multiple horizontal text columns detected.",
                fix="Convert layout into a single-column top-to-bottom sequence so ATS reads chronology correctly.",
            )
        )

    if has_tables:
        layout_earned -= 5.0
        layout_deductions.append(
            CheckDeduction(
                code="TABLES_PRESENT",
                severity="medium",
                points_lost=5.0,
                evidence="Embedded layout tables detected in document structure.",
                fix="Replace tables and grid cells with clean bulleted lists; tables frequently scramble ATS order.",
            )
        )

    if has_header_footer:
        layout_earned -= 5.0
        layout_deductions.append(
            CheckDeduction(
                code="HEADER_FOOTER_CONTENT",
                severity="medium",
                points_lost=5.0,
                evidence="Text content located within top/bottom margin zones.",
                fix="Move contact info and experience into the main document body; ATS parsers skip margins.",
            )
        )

    checks.append(
        Check(
            id="layout_safety",
            category="layout_safety",
            max_points=20.0,
            earned_points=max(0.0, layout_earned),
            status="failed" if layout_deductions else "passed",
            deductions=layout_deductions,
        )
    )

    # -------------------------------------------------------------------------
    # 3. STANDARD STRUCTURE (20 pts)
    #    - Work / Project Experience (8 pts) - Projects counts for students!
    #    - Education (6 pts)
    #    - Skills (6 pts)
    # -------------------------------------------------------------------------
    structure_deductions: list[CheckDeduction] = []
    structure_earned = 20.0

    # Rule: Student/project resumes satisfy experience via projects
    has_experience_or_projects = (
        experience_count > 0
        or projects_count > 0
        or "experience" in sections
        or "work history" in sections
        or "projects" in sections
    )
    if not has_experience_or_projects:
        structure_earned -= 8.0
        structure_deductions.append(
            CheckDeduction(
                code="MISSING_SECTION_EXPERIENCE",
                severity="high",
                points_lost=8.0,
                evidence="No standard Experience or Projects section header detected.",
                fix="Add a clearly labeled 'Experience' or 'Projects' section heading.",
            )
        )

    has_education = (
        education_count > 0
        or "education" in sections
        or "academic" in sections
        or "academics" in sections
    )
    if not has_education:
        structure_earned -= 6.0
        structure_deductions.append(
            CheckDeduction(
                code="MISSING_SECTION_EDUCATION",
                severity="medium",
                points_lost=6.0,
                evidence="No standard Education section header detected.",
                fix="Add an 'Education' section heading with degree and institution.",
            )
        )

    has_skills = skills_count > 0 or "skills" in sections or "technical skills" in sections
    if not has_skills:
        structure_earned -= 6.0
        structure_deductions.append(
            CheckDeduction(
                code="MISSING_SECTION_SKILLS",
                severity="medium",
                points_lost=6.0,
                evidence="No dedicated Skills or Technical Skills section header detected.",
                fix="Add a dedicated 'Skills' section listing your core tools and competencies.",
            )
        )

    checks.append(
        Check(
            id="standard_structure",
            category="structure",
            max_points=20.0,
            earned_points=max(0.0, structure_earned),
            status="failed" if structure_deductions else "passed",
            deductions=structure_deductions,
        )
    )

    # -------------------------------------------------------------------------
    # 4. CONTACT REACHABILITY (10 pts)
    #    - Email parsed (10 pts)
    #    (Phone and links are optional; absent is not broken)
    # -------------------------------------------------------------------------
    contact_deductions: list[CheckDeduction] = []
    contact_earned = 10.0

    if is_contact_in_header_only:
        loss = 10.0
        contact_earned = max(0.0, contact_earned - loss)
        contact_deductions.append(
            CheckDeduction(
                code="CONTACT_IN_HEADER_FOOTER",
                severity="critical",
                points_lost=loss,
                evidence="Contact details appear only within header/footer margin streams, which many ATS parsers skip.",
                fix="Move contact details into the main document body stream.",
            )
        )
    elif not contact_email:
        contact_earned = 0.0
        contact_deductions.append(
            CheckDeduction(
                code="MISSING_CONTACT_EMAIL",
                severity="high",
                points_lost=10.0,
                evidence="No valid email address was identified in contact information.",
                fix="Add a professional email address at the top of your resume.",
            )
        )

    checks.append(
        Check(
            id="contact_reachability",
            category="contact",
            max_points=10.0,
            earned_points=contact_earned,
            status="failed" if contact_deductions else "passed",
            deductions=contact_deductions,
        )
    )

    # Optional check: links verification (evaluated only when status is determined)
    if check_links_status != "unknown":
        checks.append(
            Check(
                id="links_parsed",
                category="contact",
                max_points=5.0,
                earned_points=5.0 if check_links_status == "passed" else 0.0,
                status=check_links_status,
            )
        )

    # -------------------------------------------------------------------------
    # 5. CONTENT HYGIENE (10 pts)
    #    - Bullet structure detected (4 pts)
    #    - No all-caps walls (3 pts)
    #    - No extreme bullet lengths (> 350 chars) (3 pts)
    # -------------------------------------------------------------------------
    hygiene_deductions: list[CheckDeduction] = []
    hygiene_earned = 10.0

    if not bullet_list:
        hygiene_earned -= 4.0
        hygiene_deductions.append(
            CheckDeduction(
                code="NO_BULLETS_DETECTED",
                severity="medium",
                points_lost=4.0,
                evidence="Experience text formatted in solid paragraph blocks without bullet points.",
                fix="Format responsibilities into concise bulleted lists for rapid ATS parsing.",
            )
        )
    else:
        # Check for extreme bullet lengths (> 350 characters)
        runaway_bullets = [b for b in bullet_list if len(b.strip()) > 350]
        if runaway_bullets:
            hygiene_earned -= 3.0
            hygiene_deductions.append(
                CheckDeduction(
                    code="EXCESSIVE_BULLET_LENGTH",
                    severity="low",
                    points_lost=3.0,
                    evidence=f"{len(runaway_bullets)} bullet point(s) exceed 350 characters.",
                    fix="Shorten lengthy bullet points to 1-2 lines (120-250 characters) for readability.",
                )
            )

    # Check for all-caps walls in body text (lines > 50 chars with 90%+ uppercase)
    all_caps_lines = [
        line
        for line in raw_text.splitlines()
        if len(line.strip()) > 50 and sum(1 for c in line if c.isupper()) / len(line.strip()) > 0.85
    ]
    if all_caps_lines:
        hygiene_earned -= 3.0
        hygiene_deductions.append(
            CheckDeduction(
                code="ALL_CAPS_TEXT_WALL",
                severity="low",
                points_lost=3.0,
                evidence="Extended paragraphs or sentences formatted in ALL CAPS detected.",
                fix="Use standard sentence case for descriptions and reserve uppercase solely for acronyms.",
            )
        )

    checks.append(
        Check(
            id="content_hygiene",
            category="content_hygiene",
            max_points=10.0,
            earned_points=max(0.0, hygiene_earned),
            status="failed" if hygiene_deductions else "passed",
            deductions=hygiene_deductions,
        )
    )

    return checks
