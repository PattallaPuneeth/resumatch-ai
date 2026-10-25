"""
Phase 4C: Deterministic ATS Hazard Mapping.
Maps stored Phase 2C hazards and ATS scores to prioritized, plain-language remediation steps.
"""

from __future__ import annotations

from typing import Any

from ml.pipelines.improvements.models import AtsFix

STATIC_HAZARD_REMEDIATIONS: dict[str, dict[str, Any]] = {
    "OCR_REQUIRED": {
        "severity": "HIGH",
        "priority": 1,
        "issue": "Scanned or image-only document lacking a selectable text layer.",
        "recommendation": (
            "Export the resume as a standard text-based PDF or DOCX file directly from Word or "
            "Google Docs so ATS parsers can read text cleanly."
        ),
    },
    "MULTI_COLUMN_LAYOUT": {
        "severity": "HIGH",
        "priority": 1,
        "issue": "Two or more side-by-side text columns detected.",
        "recommendation": (
            "Convert multi-column blocks into a single-column top-to-bottom layout to prevent "
            "automated parsers from reading across column boundaries."
        ),
    },
    "MISSING_SECTION_EXPERIENCE": {
        "severity": "HIGH",
        "priority": 1,
        "issue": "Missing standard 'Experience' or 'Work History' section header.",
        "recommendation": (
            "Add a prominent 'Experience' header above your employment chronology so ATS systems "
            "can index your work history."
        ),
    },
    "TABLES_PRESENT": {
        "severity": "MEDIUM",
        "priority": 2,
        "issue": "Embedded layout tables detected in document structure.",
        "recommendation": (
            "Replace layout tables and grids with standard left-aligned bulleted lists; tables "
            "frequently scramble cell contents during ATS text extraction."
        ),
    },
    "HEADER_FOOTER_CONTENT": {
        "severity": "MEDIUM",
        "priority": 2,
        "issue": "Text located inside document margin headers or footers.",
        "recommendation": (
            "Move contact info, email, phone, and links into the main body of the document; "
            "header and footer zones are routinely omitted by ATS parsers."
        ),
    },
    "MISSING_SECTION_EDUCATION": {
        "severity": "MEDIUM",
        "priority": 2,
        "issue": "Missing standard 'Education' section header.",
        "recommendation": (
            "Add an explicit 'Education' section header above degree and university entries."
        ),
    },
    "MISSING_SECTION_SKILLS": {
        "severity": "MEDIUM",
        "priority": 2,
        "issue": "Missing standard 'Skills' section header.",
        "recommendation": (
            "Include a dedicated 'Skills' or 'Technical Skills' section to "
            "maximize keyword recognition."
        ),
    },
    "UNUSUAL_FONTS": {
        "severity": "LOW",
        "priority": 3,
        "issue": "Non-standard typography or exotic font families used.",
        "recommendation": (
            "Use clean, universally recognized ATS fonts such as Arial, Calibri, Helvetica, "
            "Times New Roman, or Georgia to avoid character encoding errors."
        ),
    },
}


def map_ats_hazards_to_fixes(
    ats_score: float | None,
    ats_hazards: list[dict[str, Any]] | None,
) -> tuple[float, list[AtsFix]]:
    """
    Transforms Phase 2C hazards into prioritized AtsFix objects.
    Guarantees that atsScore is always a valid float 0.0..100.0.
    """
    score = 100.0 if ats_score is None else max(0.0, min(100.0, float(ats_score)))
    fixes: list[AtsFix] = []

    if not ats_hazards:
        return score, fixes

    seen_codes: set[str] = set()

    for hazard in ats_hazards:
        code = str(hazard.get("code") or "").strip().upper()
        if not code or code in seen_codes:
            continue
        seen_codes.add(code)

        rem = STATIC_HAZARD_REMEDIATIONS.get(code)
        if rem:
            fixes.append(
                AtsFix(
                    hazardCode=code,
                    severity=rem["severity"],
                    issue=rem["issue"],
                    recommendation=rem["recommendation"],
                    priority=rem["priority"],
                )
            )
        else:
            # Fallback for unrecognized hazard codes
            raw_title = str(hazard.get("title") or code)
            raw_desc = str(hazard.get("description") or "ATS formatting hazard detected.")
            raw_sev = str(hazard.get("severity") or "MEDIUM").upper()
            sev: Any = raw_sev if raw_sev in ("HIGH", "MEDIUM", "LOW") else "MEDIUM"
            prio = 1 if sev == "HIGH" else (2 if sev == "MEDIUM" else 3)
            fixes.append(
                AtsFix(
                    hazardCode=code,
                    severity=sev,
                    issue=raw_title,
                    recommendation=raw_desc,
                    priority=prio,
                )
            )

    # Sort fixes by priority ascending, then severity
    sev_rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    fixes.sort(key=lambda f: (f.priority, sev_rank.get(f.severity, 3)))

    return score, fixes
