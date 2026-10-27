"""
Builds the binary load-test fixtures from the committed synthetic dataset (Phase 10B).
Run inside the ML image (PyMuPDF available):

  docker compose run --rm --no-deps -T -v "$PWD/loadtest/fixtures:/out" -v "$PWD/test-data:/src:ro" \
    ml python /out/generate_fixtures.py

Outputs (synthetic data only, no real PII):
  text_1p.pdf        text-layer PDF (copy of test-data/resumes/resume_02_backend_python.pdf)
  docx_1p.docx       DOCX (copy of test-data/resumes/resume_01_backend_node.docx)
  scan_1p.pdf        image-only PDF of the text PDF's first page (forces OCR)
  scan_5p.pdf        image-only PDF, 5 pages (forces OCR)
  heavy_5mb.pdf      image-heavy PDF just under the 5 MB upload cap (worst case)
"""

from __future__ import annotations

import random
import shutil
from pathlib import Path

import fitz  # PyMuPDF

SRC = Path("/src/resumes")
OUT = Path("/out")
MAX_UPLOAD_BYTES = 5 * 1024 * 1024


def image_only_pdf(src_pdf: Path, pages: int, dpi: int) -> fitz.Document:
    src = fitz.open(src_pdf)
    out = fitz.open()
    for i in range(pages):
        page = src[i % len(src)]
        pix = page.get_pixmap(dpi=dpi)
        new_page = out.new_page(width=page.rect.width, height=page.rect.height)
        new_page.insert_image(new_page.rect, stream=pix.tobytes("png"))
    return out


def heavy_pdf(src_pdf: Path) -> bytes:
    """Scanned first page plus noise images, sized to just under MAX_UPLOAD_BYTES."""
    rng = random.Random(42)
    doc = image_only_pdf(src_pdf, pages=1, dpi=150)
    noise_pages = 0
    last = doc.tobytes(garbage=3, deflate=True)
    while True:
        trial = fitz.open()
        trial.insert_pdf(doc)
        for _ in range(noise_pages):
            samples = bytearray(rng.getrandbits(8) for _ in range(600 * 600 * 3))
            noisy = fitz.Pixmap(fitz.csRGB, 600, 600, bytes(samples), False)
            p = trial.new_page()
            p.insert_image(p.rect, pixmap=noisy)
        data = trial.tobytes(garbage=3, deflate=True)
        if len(data) > MAX_UPLOAD_BYTES - 64 * 1024:
            return last
        last = data
        noise_pages += 1


def main() -> None:
    text_pdf = SRC / "resume_02_backend_python.pdf"
    shutil.copyfile(text_pdf, OUT / "text_1p.pdf")
    shutil.copyfile(SRC / "resume_01_backend_node.docx", OUT / "docx_1p.docx")
    image_only_pdf(text_pdf, pages=1, dpi=200).save(OUT / "scan_1p.pdf", garbage=3, deflate=True)
    image_only_pdf(text_pdf, pages=5, dpi=200).save(OUT / "scan_5p.pdf", garbage=3, deflate=True)
    (OUT / "heavy_5mb.pdf").write_bytes(heavy_pdf(text_pdf))
    for f in sorted(OUT.glob("*.pdf")) + sorted(OUT.glob("*.docx")):
        print(f"{f.name}: {f.stat().st_size} bytes")


if __name__ == "__main__":
    main()
