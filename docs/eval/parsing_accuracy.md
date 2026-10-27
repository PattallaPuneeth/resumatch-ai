# ResuMatch AI ΓÇö Document Parsing Accuracy Benchmark (Phase 10A)

Evaluation of intake parser across synthetic Microsoft Word DOCX and digital PDF documents.

## 1. Aggregate Quality Metrics

- **Total Evaluated Documents:** 24
- **Mean Character Error Rate (CER):** `2.92%`
- **Mean Word Error Rate (WER):** `2.48%`
- **Section Extraction Accuracy:** `100.00%`

## 2. Performance Breakdown by Format

| Format | Document Count | Mean CER | Mean WER | Section Accuracy |
| :--- | :---: | :---: | :---: | :---: |
| **PDF_TEXT** | 12 | `1.43%` | `3.09%` | `100.00%` |
| **DOCX** | 12 | `4.40%` | `1.87%` | `100.00%` |

## 3. Detailed Per-Case Evaluation Log

| Case ID | Format | Reference Chars | Extracted Chars | CER | WER | Section Acc |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `case_01_docx` | DOCX | 836 | 871 | 4.19% | 1.69% | 100.00% |
| `case_02_pdf_text` | PDF_TEXT | 841 | 850 | 1.66% | 3.39% | 100.00% |
| `case_03_docx` | DOCX | 740 | 774 | 4.59% | 2.00% | 100.00% |
| `case_04_pdf_text` | PDF_TEXT | 745 | 752 | 1.34% | 3.00% | 100.00% |
| `case_05_docx` | DOCX | 768 | 802 | 4.43% | 1.92% | 100.00% |
| `case_06_pdf_text` | PDF_TEXT | 773 | 780 | 1.29% | 2.88% | 100.00% |
| `case_07_docx` | DOCX | 836 | 871 | 4.19% | 1.69% | 100.00% |
| `case_08_pdf_text` | PDF_TEXT | 841 | 850 | 1.66% | 3.39% | 100.00% |
| `case_09_docx` | DOCX | 740 | 774 | 4.59% | 2.00% | 100.00% |
| `case_10_pdf_text` | PDF_TEXT | 745 | 752 | 1.34% | 3.00% | 100.00% |
| `case_11_docx` | DOCX | 768 | 802 | 4.43% | 1.92% | 100.00% |
| `case_12_pdf_text` | PDF_TEXT | 773 | 780 | 1.29% | 2.88% | 100.00% |
| `case_13_docx` | DOCX | 836 | 871 | 4.19% | 1.69% | 100.00% |
| `case_14_pdf_text` | PDF_TEXT | 841 | 850 | 1.66% | 3.39% | 100.00% |
| `case_15_docx` | DOCX | 740 | 774 | 4.59% | 2.00% | 100.00% |
| `case_16_pdf_text` | PDF_TEXT | 745 | 752 | 1.34% | 3.00% | 100.00% |
| `case_17_docx` | DOCX | 768 | 802 | 4.43% | 1.92% | 100.00% |
| `case_18_pdf_text` | PDF_TEXT | 773 | 780 | 1.29% | 2.88% | 100.00% |
| `case_19_docx` | DOCX | 836 | 871 | 4.19% | 1.69% | 100.00% |
| `case_20_pdf_text` | PDF_TEXT | 841 | 850 | 1.66% | 3.39% | 100.00% |
| `case_21_docx` | DOCX | 740 | 774 | 4.59% | 2.00% | 100.00% |
| `case_22_pdf_text` | PDF_TEXT | 745 | 752 | 1.34% | 3.00% | 100.00% |
| `case_23_docx` | DOCX | 768 | 802 | 4.43% | 1.92% | 100.00% |
| `case_24_pdf_text` | PDF_TEXT | 773 | 780 | 1.29% | 2.88% | 100.00% |
