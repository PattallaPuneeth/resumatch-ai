from ml.pipelines.intake.models import AtsHazard

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


def analyze_ats_hazards(
    is_ocr_required: bool,
    has_multi_column: bool,
    has_tables: bool,
    has_header_footer: bool,
    fonts_detected: set[str],
    sections_found: set[str],
) -> tuple[float, list[AtsHazard]]:
    """
    Evaluates document layout against standard ATS parser rules.
    Returns (ats_score: float 0..100, hazards: list[AtsHazard]).
    """
    hazards: list[AtsHazard] = []
    deductions = 0.0

    # 1. OCR Required Hazard
    if is_ocr_required:
        hazards.append(
            AtsHazard(
                code="OCR_REQUIRED",
                title="Image-Only / Scanned Document",
                description=(
                    "The resume lacks a selectable text layer and required optical character "
                    "recognition (OCR). Legacy ATS systems cannot parse image-only files."
                ),
                severity="HIGH",
            )
        )
        deductions += 25.0

    # 2. Multi-column Layout Hazard
    if has_multi_column:
        hazards.append(
            AtsHazard(
                code="MULTI_COLUMN_LAYOUT",
                title="Multi-Column Layout Detected",
                description=(
                    "Two or more side-by-side text columns were detected. ATS parsers frequently "
                    "read across columns horizontally, mixing unrelated work history and dates."
                ),
                severity="HIGH",
            )
        )
        deductions += 15.0

    # 3. Tables Hazard
    if has_tables:
        hazards.append(
            AtsHazard(
                code="TABLES_PRESENT",
                title="Embedded Tables Detected",
                description=(
                    "Tables were used for layout formatting. Many ATS parsers drop table contents "
                    "or flatten cells in unexpected order."
                ),
                severity="MEDIUM",
            )
        )
        deductions += 15.0

    # 4. Header / Footer Content Hazard
    if has_header_footer:
        hazards.append(
            AtsHazard(
                code="HEADER_FOOTER_CONTENT",
                title="Content Located in Headers or Footers",
                description=(
                    "Critical text (such as contact information) appears inside "
                    "margins/headers/footers, which are routinely ignored by automated ATS parsers."
                ),
                severity="MEDIUM",
            )
        )
        deductions += 10.0

    # 5. Unusual Fonts Hazard
    unusual_fonts = [
        f
        for f in fonts_detected
        if f.lower() not in STANDARD_ATS_FONTS
        and not any(sf in f.lower() for sf in STANDARD_ATS_FONTS)
    ]
    if unusual_fonts:
        hazards.append(
            AtsHazard(
                code="UNUSUAL_FONTS",
                title="Non-Standard Typography",
                description=(
                    f"Document uses unusual font families ({', '.join(unusual_fonts[:3])}) "
                    "that may cause character substitution errors in ATS parsers."
                ),
                severity="LOW",
            )
        )
        deductions += 10.0

    # 6. Missing Standard Sections
    key_sections = {"experience", "education", "skills"}
    missing = key_sections - sections_found
    for sec in missing:
        hazards.append(
            AtsHazard(
                code=f"MISSING_SECTION_{sec.upper()}",
                title=f"Missing {sec.capitalize()} Section Header",
                description=(
                    f"Could not locate an explicit '{sec.capitalize()}' section header. "
                    "ATS categorization depends on recognized section delimiters."
                ),
                severity="MEDIUM",
            )
        )
        deductions += 10.0

    # Final score from 0 to 100
    final_score = max(0.0, min(100.0, round(100.0 - deductions, 1)))
    return final_score, hazards
