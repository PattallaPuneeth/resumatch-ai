import io
import os
import re
from collections.abc import Callable

import docx
import fitz  # PyMuPDF
import pytesseract
from ml.config import settings
from ml.pipelines.intake.entities import (
    _find_sections,
    extract_contact_info,
    extract_education,
    extract_experience,
    extract_skills,
)
from ml.pipelines.intake.exceptions import (
    CorruptFileError,
    EncryptedPdfError,
    TextTooShortAfterOcrError,
    TooManyPagesError,
    UnsupportedTypeError,
)
from ml.pipelines.intake.hazards import analyze_ats_hazards
from ml.pipelines.intake.models import DocumentParseResult
from PIL import Image


def _is_alphanumeric_ratio_low(text: str, threshold: float = 0.50) -> bool:
    """Checks whether the ratio of alphanumeric chars to total characters is below threshold."""
    stripped = text.strip()
    if not stripped:
        return True
    alnum_count = sum(1 for c in stripped if c.isalnum())
    return (alnum_count / len(stripped)) < threshold


def _extract_pdf_blocks(doc: fitz.Document) -> tuple[str, bool, bool, set[str]]:
    """
    Extracts text blocks from PyMuPDF document with column-aware ordering.
    Returns: (text, has_multi_column, has_header_footer, fonts_detected)
    """
    all_pages_text: list[str] = []
    has_multi_column = False
    has_header_footer = False
    fonts_detected: set[str] = set()

    for _page_idx, page in enumerate(doc):
        page_rect = page.rect
        width, height = page_rect.width, page_rect.height

        # extract blocks: (x0, y0, x1, y1, text, block_no, block_type)
        blocks = page.get_text("blocks")
        text_blocks = [b for b in blocks if b[6] == 0 and b[4].strip()]  # type 0 = text

        if not text_blocks:
            continue

        # Check for header/footer margins (top < 50pt, bottom > height - 50pt)
        for b in text_blocks:
            y0, y1 = b[1], b[3]
            if y0 < 50 or y1 > (height - 50):
                has_header_footer = True

        # Check for multi-column layout on this page:
        # A 2-column page has blocks with x0 in left & right halves with overlapping y-ranges
        left_blocks = [b for b in text_blocks if b[0] < width * 0.45]
        right_blocks = [b for b in text_blocks if b[0] >= width * 0.48]

        page_is_multi_column = False
        if len(left_blocks) >= 2 and len(right_blocks) >= 2:
            # Check for vertical overlap between left and right blocks
            has_overlap = False
            for lb in left_blocks:
                for rb in right_blocks:
                    if max(lb[1], rb[1]) < min(lb[3], rb[3]):
                        has_overlap = True
                        break
                if has_overlap:
                    break
            if has_overlap:
                page_is_multi_column = True
                has_multi_column = True

        # Sort blocks: if multi-column, sort by column then vertical; otherwise sort vertically
        if page_is_multi_column:
            # Group into left and right columns
            sorted_blocks = sorted(left_blocks, key=lambda b: (b[1], b[0])) + sorted(
                right_blocks, key=lambda b: (b[1], b[0])
            )
        else:
            sorted_blocks = sorted(text_blocks, key=lambda b: (b[1], b[0]))

        page_text = "\n".join(b[4].strip() for b in sorted_blocks if b[4].strip())
        all_pages_text.append(page_text)

        # Extract font families from page text spans
        try:
            dict_data = page.get_text("dict")
            for block in dict_data.get("blocks", []):
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        font_name = span.get("font")
                        if font_name:
                            # Clean font prefix (e.g. ABCDE+ArialMT -> Arial)
                            clean_font = re.sub(r"^[A-Z]{6}\+", "", font_name)
                            clean_font = re.sub(
                                r"(-MT|-Bold|-Regular|-Italic|MT|PS)", "", clean_font
                            )
                            fonts_detected.add(clean_font.strip())
        except Exception:
            pass

    full_text = "\n\n".join(all_pages_text)
    return full_text, has_multi_column, has_header_footer, fonts_detected


def _run_pdf_ocr(doc: fitz.Document) -> str:
    """Renders PDF pages to pixmaps and extracts text via Tesseract OCR."""
    ocr_pages_text: list[str] = []
    max_pages = min(len(doc), settings.ocr_max_pages)

    for page_idx in range(max_pages):
        page = doc[page_idx]
        # Render page using configured DPI
        zoom = settings.ocr_dpi / 72.0
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        # Convert to PIL Image
        img_bytes = pix.tobytes("png")
        image = Image.open(io.BytesIO(img_bytes))

        # Run Tesseract OCR
        page_text = pytesseract.image_to_string(image, lang="eng")
        ocr_pages_text.append(page_text.strip())

    return "\n\n".join(p for p in ocr_pages_text if p)


def _extract_docx(file_path: str) -> tuple[str, bool, bool]:
    """
    Extracts text and layout details from DOCX document.
    Returns: (text, has_tables, has_header_footer)
    """
    try:
        doc = docx.Document(file_path)
    except Exception as e:
        raise CorruptFileError(f"Failed to read DOCX file: {e}") from e

    parts: list[str] = []
    has_tables = len(doc.tables) > 0
    has_header_footer = False

    # Check headers / footers
    for section in doc.sections:
        if section.header and any(p.text.strip() for p in section.header.paragraphs):
            has_header_footer = True
            for p in section.header.paragraphs:
                if p.text.strip():
                    parts.append(p.text.strip())
        if section.footer and any(p.text.strip() for p in section.footer.paragraphs):
            has_header_footer = True
            for p in section.footer.paragraphs:
                if p.text.strip():
                    parts.append(p.text.strip())

    # Main paragraphs
    for p in doc.paragraphs:
        if p.text.strip():
            parts.append(p.text.strip())

    # Tables text
    for table in doc.tables:
        for row in table.rows:
            row_texts = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if row_texts:
                parts.append(" | ".join(row_texts))

    full_text = "\n\n".join(parts)
    return full_text, has_tables, has_header_footer


def parse_document(
    file_path: str,
    mime_type: str,
    status_callback: Callable[[str], None] | None = None,
) -> DocumentParseResult:
    """
    Parses a PDF or DOCX resume document according to Section 6 Phase 2C.
    Executes text extraction, quality gating, OCR fallback, ATS hazard detection,
    and entity extraction with exact canonical character offsets.
    """
    if not os.path.exists(file_path):
        raise CorruptFileError("Document file not found on disk.")

    ext = file_path.split(".")[-1].lower()
    is_pdf = mime_type == "application/pdf" or ext == "pdf"
    is_docx = (
        mime_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        or ext == "docx"
    )

    if not is_pdf and not is_docx:
        raise UnsupportedTypeError(f"Unsupported document format: {mime_type} (.{ext})")

    has_multi_column = False
    has_tables = False
    has_header_footer = False
    is_ocr_required = False
    fonts_detected: set[str] = set()
    page_count = 1
    raw_text = ""
    extraction_method = "TEXT_LAYER"

    if is_pdf:
        try:
            doc = fitz.open(file_path)
        except Exception as e:
            raise CorruptFileError(f"Failed to open PDF document: {e}") from e

        try:
            if doc.is_encrypted:
                raise EncryptedPdfError("PDF document is encrypted.")

            page_count = len(doc)
            if page_count > settings.max_resume_pages:
                raise TooManyPagesError(
                    f"PDF page count ({page_count}) exceeds limit of {settings.max_resume_pages}."
                )

            # Extract digital text layer
            (
                extracted_text,
                has_multi_column,
                has_header_footer,
                fonts_detected,
            ) = _extract_pdf_blocks(doc)

            # Quality gate: check length and alphanumeric ratio
            text_length = len(extracted_text.strip())
            needs_ocr = text_length < settings.ocr_min_chars or _is_alphanumeric_ratio_low(
                extracted_text, settings.ocr_alphanumeric_threshold
            )

            if needs_ocr:
                is_ocr_required = True
                extraction_method = "OCR"

                if status_callback:
                    status_callback("NEEDS_OCR")
                    status_callback("OCR_PROCESSING")

                ocr_text = _run_pdf_ocr(doc)
                if len(ocr_text.strip()) < settings.ocr_min_chars:
                    raise TextTooShortAfterOcrError(
                        f"Extracted OCR text too short ({len(ocr_text.strip())} characters)."
                    )
                raw_text = ocr_text
            else:
                raw_text = extracted_text
                extraction_method = "TEXT_LAYER"
        finally:
            doc.close()

    elif is_docx:
        raw_text, has_tables, has_header_footer = _extract_docx(file_path)
        extraction_method = "DOCX"
        page_count = max(1, len(raw_text) // 2500)  # estimate pages for DOCX

    # Canonicalize raw_text: normalize whitespace and paragraphs
    paragraphs = [p.strip() for p in raw_text.split("\n") if p.strip()]
    canonical_text = "\n\n".join(paragraphs)

    if not canonical_text:
        raise CorruptFileError("Document contains no readable text content.")

    # Section mapping on canonical text
    sections = _find_sections(canonical_text)
    sections_found = set(sections.keys())

    # ATS Hazard Analysis and Scoring
    ats_score, ats_hazards = analyze_ats_hazards(
        is_ocr_required=is_ocr_required,
        has_multi_column=has_multi_column,
        has_tables=has_tables,
        has_header_footer=has_header_footer,
        fonts_detected=fonts_detected,
        sections_found=sections_found,
    )

    # Extract Entities with exact offsets referencing canonical_text
    contact, candidate_name = extract_contact_info(canonical_text)
    skills = extract_skills(canonical_text, sections)
    experience = extract_experience(canonical_text, sections)
    education = extract_education(canonical_text, sections)

    # Extract summary if present
    summary_text = None
    if "summary" in sections:
        s_start, s_end = sections["summary"]
        summary_raw = canonical_text[s_start:s_end].split("\n")
        # Exclude the section header itself
        summary_content = "\n".join(summary_raw[1:]).strip()
        if summary_content:
            summary_text = summary_content

    return DocumentParseResult(
        raw_text=canonical_text,
        page_count=page_count,
        extraction_method=extraction_method,
        candidate_name=candidate_name,
        contact=contact,
        summary=summary_text,
        skills=skills,
        experience=experience,
        education=education,
        ats_score=ats_score,
        ats_hazards=ats_hazards,
        parsing_metadata={
            "fonts": list(fonts_detected),
            "multi_column": has_multi_column,
            "has_tables": has_tables,
            "has_header_footer": has_header_footer,
            "is_ocr_required": is_ocr_required,
            "ocr_dpi": settings.ocr_dpi if is_ocr_required else None,
        },
    )
