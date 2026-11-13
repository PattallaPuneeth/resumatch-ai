import io
import os
import re
import zipfile
from collections.abc import Callable

import docx
import fitz  # PyMuPDF
import pytesseract
from ml.config import settings
from ml.pipelines.intake.content_insights import extract_content_insights
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
    OcrDeferredError,
    TextTooShortAfterOcrError,
    TooManyPagesError,
    UnsupportedTypeError,
)
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
        if width > 3000.0 or height > 3000.0:
            raise CorruptFileError(
                f"PDF page dimensions ({width}x{height}) exceed maximum safety limit."
            )

        # extract blocks: (x0, y0, x1, y1, text, block_no, block_type)
        blocks = page.get_text("blocks")
        text_blocks = [b for b in blocks if b[6] == 0 and b[4].strip()]  # type 0 = text

        if not text_blocks:
            continue

        # Check for header/footer margins:
        # On single-page resumes, top margin banner text (< 50pt) containing contact details
        # is standard. Hazard is body text repeating across pages or non-contact body text
        # crammed in extreme margins (< 20pt / > height - 20pt)
        if len(doc) > 1:
            for b in text_blocks:
                y0, y1 = b[1], b[3]
                if (y0 < 40 or y1 > (height - 40)) and len(b[4].strip()) > 15:
                    has_header_footer = True
        else:
            for b in text_blocks:
                y0, y1 = b[1], b[3]
                if (y0 < 20 or y1 > (height - 20)) and len(b[4].strip()) > 50:
                    has_header_footer = True

        # Check for multi-column layout on this page:
        # A 2-column page has substantive blocks in left & right halves with overlapping y-ranges
        left_blocks = [b for b in text_blocks if b[0] < width * 0.45]
        right_blocks = [
            b
            for b in text_blocks
            if b[0] >= width * 0.48 and len(b[4].strip()) > 25 and (b[2] - b[0]) > width * 0.15
        ]

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
                            # Clean font prefix (e.g. ABCDE+ArialMT -> ArialMT)
                            clean_font = re.sub(r"^[A-Z]{6}\+", "", font_name)
                            clean_font = re.sub(
                                r"[,\-_](Bold|Regular|Italic|Light|Medium|Black|Roman|Oblique).*",
                                "",
                                clean_font,
                                flags=re.IGNORECASE,
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
        page_rect = page.rect
        # Render page using configured DPI, capping maximum pixel dimension to 4096px
        zoom = settings.ocr_dpi / 72.0
        max_pixel_dim = 4096.0
        calc_width = page_rect.width * zoom
        calc_height = page_rect.height * zoom
        if calc_width > max_pixel_dim or calc_height > max_pixel_dim:
            scale = min(max_pixel_dim / calc_width, max_pixel_dim / calc_height)
            zoom = zoom * scale
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat, alpha=False)

        # Convert to PIL Image
        img_bytes = pix.tobytes("png")
        image = Image.open(io.BytesIO(img_bytes))

        # Run Tesseract OCR
        page_text = pytesseract.image_to_string(image, lang="eng")
        ocr_pages_text.append(page_text.strip())

    return "\n\n".join(p for p in ocr_pages_text if p)


def _check_docx_zip_safety(
    file_path: str,
    max_uncompressed_bytes: int = 50 * 1024 * 1024,
    max_ratio: float = 100.0,
) -> None:
    """Validates DOCX zip structure against decompression bombs and macro payloads."""
    try:
        with zipfile.ZipFile(file_path, "r") as zf:
            total_uncompressed = 0
            has_macro = False
            for info in zf.infolist():
                total_uncompressed += info.file_size
                if total_uncompressed > max_uncompressed_bytes:
                    raise CorruptFileError(
                        "DOCX uncompressed size exceeds safety limit of "
                        f"{max_uncompressed_bytes // (1024 * 1024)}MB."
                    )
                ratio = info.file_size / max(info.compress_size, 1)
                if info.file_size > 1024 and ratio > max_ratio:
                    raise CorruptFileError(
                        f"DOCX entry '{info.filename}' compression ratio exceeds safety "
                        "threshold (potential zip bomb)."
                    )
                if "vbaProject.bin" in info.filename or info.filename.endswith(".bin"):
                    has_macro = True
            if has_macro:
                raise CorruptFileError(
                    "DOCX contains macros or executable payloads which are disallowed."
                )
    except zipfile.BadZipFile as bz:
        raise CorruptFileError(f"Corrupted or invalid DOCX archive: {bz}") from bz


def _extract_docx(file_path: str) -> tuple[str, bool, bool]:
    """
    Extracts text and layout details from DOCX document.
    Returns: (text, has_tables, has_header_footer)
    """
    _check_docx_zip_safety(file_path)

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
            header_text = " ".join(
                p.text.strip() for p in section.header.paragraphs if p.text.strip()
            )
            # Flag if header contains contact info or substantive body text (> 30 chars)
            if len(header_text) > 30 or "@" in header_text:
                has_header_footer = True
            for p in section.header.paragraphs:
                if p.text.strip():
                    parts.append(p.text.strip())
        if section.footer and any(p.text.strip() for p in section.footer.paragraphs):
            footer_text = " ".join(
                p.text.strip() for p in section.footer.paragraphs if p.text.strip()
            )
            if len(footer_text) > 30:
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
    allow_ocr: bool = True,
) -> DocumentParseResult:
    """
    Parses a PDF or DOCX resume document according to Section 6 Phase 2C.
    Executes text extraction, quality gating, OCR fallback, content insights,
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

            if needs_ocr and not allow_ocr:
                if status_callback:
                    status_callback("NEEDS_OCR")
                raise OcrDeferredError("PDF needs OCR; deferred to resume-ocr-queue")

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

    # Strip private-use glyphs (e.g. FontAwesome icon codes)
    raw_text = re.sub(r"[\uE000-\uF8FF\u0080-\u009F]", "", raw_text)

    # Canonicalize raw_text: normalize whitespace and paragraphs
    paragraphs = [p.strip() for p in raw_text.split("\n") if p.strip()]
    canonical_text = "\n\n".join(paragraphs)

    if not canonical_text:
        raise CorruptFileError("Document contains no readable text content.")

    # Calculate extractability ratio on non-whitespace characters
    non_ws = [c for c in canonical_text if not c.isspace()]
    if non_ws:
        bad_chars = sum(1 for c in non_ws if c == "\ufffd" or 0xE000 <= ord(c) <= 0xF8FF)
        cid_count = len(re.findall(r"\(cid:\d+\)", canonical_text)) * 5
        extractability_ratio = max(0.0, (len(non_ws) - bad_chars - cid_count) / len(non_ws))
    else:
        extractability_ratio = 1.0

    # Section mapping on canonical text
    sections = _find_sections(canonical_text)

    # Extract Entities with exact offsets referencing canonical_text BEFORE scoring
    contact, candidate_name = extract_contact_info(canonical_text)
    skills = extract_skills(canonical_text, sections)
    education = extract_education(canonical_text, sections)

    # Extract experience; fall back to projects if formal experience is absent
    experience = extract_experience(canonical_text, sections, section_key="experience")
    experience_source = "experience"
    if not experience and "projects" in sections:
        experience = extract_experience(canonical_text, sections, section_key="projects")
        if experience:
            experience_source = "projects"

    # Unscored writing observations (never a score)
    content_insights = extract_content_insights(
        experience_items=experience,
        skills=skills,
        raw_text=canonical_text,
    )

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
        parsing_metadata={
            "fonts": list(fonts_detected),
            "multi_column": has_multi_column,
            "has_tables": has_tables,
            "has_header_footer": has_header_footer,
            "is_ocr_required": is_ocr_required,
            "ocr_dpi": settings.ocr_dpi if is_ocr_required else None,
            "extractability_ratio": round(extractability_ratio, 3),
            "experience_source": experience_source,
            "content_insights": content_insights,
        },
    )
