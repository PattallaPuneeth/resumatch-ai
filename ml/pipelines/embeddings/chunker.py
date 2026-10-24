"""
Phase 3A: Section-Aware Chunker for ResuMatch AI.

Splits canonical ParsedResume.rawText into semantic, section-aware chunks
targeting 160–240 tokens with approximately 20% overlap.

Input Limit & Truncation Safety:
- sentence-transformers/all-MiniLM-L6-v2 enforces a hard max_seq_length = 256.
- Accounting for [CLS] and [SEP] special tokens, the maximum allowable content
  tokens per chunk before silent truncation is 254 tokens.
- We set TARGET_MAX_TOKENS = 240 (nominal ~200, overlap ~40) to guarantee zero
  silent token truncation during vector embedding.

Offset Convention:
- `start_char` and `end_char` are 0-indexed character offsets into `raw_text`.
- The convention guarantees that `raw_text[chunk.start_char:chunk.end_char] == chunk.content`.
- Text is sliced directly from `raw_text` without arbitrary mutations or fabrications.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from transformers import AutoTokenizer

from ml.config import settings

# Target token boundaries: strictly <= 240 tokens to prevent model truncation (ceiling: 254)
TARGET_MIN_TOKENS = 160
TARGET_MAX_TOKENS = 240
DEFAULT_OVERLAP_RATIO = 0.20  # ~20% token overlap

MODEL_NAME = getattr(settings, "embedding_model_name", "sentence-transformers/all-MiniLM-L6-v2")
_TOKENIZER: Any | None = None


def get_tokenizer() -> Any:
    """Returns singleton tokenizer instance for all-MiniLM-L6-v2."""
    global _TOKENIZER
    if _TOKENIZER is None:
        _TOKENIZER = AutoTokenizer.from_pretrained(MODEL_NAME)
    return _TOKENIZER


@dataclass(frozen=True)
class TextChunk:
    chunk_index: int
    section_type: str  # 'SUMMARY' | 'EXPERIENCE' | 'SKILLS' | 'EDUCATION' | 'OTHER'
    heading: str | None
    content: str
    start_char: int
    end_char: int
    token_count: int
    metadata: dict[str, Any]

    @property
    def embedding_text(self) -> str:
        """
        Returns the text representation used for semantic embedding.
        Retains heading context (e.g. 'TECHNICAL SKILLS\n...') without mutating
        the canonical source slice in content or violating exact character offsets.
        """
        if self.heading and not self.content.startswith(self.heading):
            return f"{self.heading}\n{self.content}"
        return self.content


# Canonical section headings patterns mapped to section_type
SECTION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    (
        "SUMMARY",
        re.compile(
            r"^(?:professional\s+summary|summary\s+of\s+qualifications|executive\s+summary|career\s+summary|"
            r"profile\s+summary|career\s+profile|personal\s+profile|about\s+me|overview|summary|"
            r"career\s+objective|objective|professional\s+profile|executive\s+profile|background\s+summary)$",
            re.IGNORECASE,
        ),
    ),
    (
        "EXPERIENCE",
        re.compile(
            r"^(?:professional\s+experience|work\s+experience|employment\s+history|work\s+history|"
            r"relevant\s+experience|relevant\s+work\s+experience|career\s+history|experience|internships|"
            r"professional\s+background|work\s+(?:&|and)\s+experience)$",
            re.IGNORECASE,
        ),
    ),
    (
        "SKILLS",
        re.compile(
            r"^(?:(?:technical\s+)?skills\s*(?:&|and)\s*(?:technologies|tools)|"
            r"technical\s+skills|skills\s*(?:&|and)\s*technologies|core\s+competencies|key\s+skills|"
            r"technical\s+proficiencies|technical\s+competencies|areas\s+of\s+expertise|technologies|"
            r"tools\s*(?:&|and)\s*technologies|skills\s*(?:&|and)\s*tools|skills|competencies|"
            r"professional\s+skills|programming\s+languages|technical\s+expertise)$",
            re.IGNORECASE,
        ),
    ),
    (
        "EDUCATION",
        re.compile(
            r"^(?:education\s*(?:&|and)\s*credentials|academic\s+background|academic\s+history|"
            r"education\s*(?:&|and)\s*training|educational\s+background|education|degrees|"
            r"academic\s+qualifications|academic\s+credentials|qualifications)$",
            re.IGNORECASE,
        ),
    ),
]

OTHER_HEADING_PATTERN = re.compile(
    r"^(?:projects|personal\s+projects|key\s+projects|certifications|"
    r"certifications\s*(?:&|and)\s*licenses|licenses\s*(?:&|and)\s*certifications|licenses|"
    r"publications|awards\s*(?:&|and)\s*honors|honors\s*(?:&|and)\s*awards|awards|"
    r"volunteer\s+experience|volunteering|languages|interests|affiliations|"
    r"activities|leadership)$",
    re.IGNORECASE,
)


@dataclass
class _DetectedHeading:
    section_type: str
    heading_text: str
    heading_start: int
    heading_end: int
    body_start: int


def _classify_heading(cleaned_line: str) -> str | None:
    """Classifies a line into a section type if it matches known heading variants."""
    for section_type, pattern in SECTION_PATTERNS:
        if pattern.match(cleaned_line):
            return section_type
    if OTHER_HEADING_PATTERN.match(cleaned_line):
        return "OTHER"
    return None


def _detect_sections(raw_text: str) -> list[tuple[str, str | None, int, int]]:
    """
    Identifies section spans in rawText.
    Returns list of (section_type, heading_text_or_none, body_start_char, body_end_char).
    """
    lines_with_offsets: list[tuple[str, int, int]] = []
    current_pos = 0
    for line in raw_text.splitlines(keepends=True):
        line_len = len(line)
        lines_with_offsets.append((line, current_pos, current_pos + line_len))
        current_pos += line_len

    detected: list[_DetectedHeading] = []

    for line_text, line_start, line_end in lines_with_offsets:
        stripped = line_text.strip()
        if not stripped or len(stripped) > 60:
            continue

        # Check for heading candidates (e.g. "EXPERIENCE", "Work Experience:", "## Skills", "1. Professional Experience")
        clean_cand = re.sub(
            r"^(?:[\s#*_\-–—]+|(?:\d+|[A-Za-z]|[IVXLCDMivxlcdm]+)[\.\)\-\:]\s*)+|[\s:*#_\-–—]+$",
            "",
            stripped,
        ).strip()
        if not clean_cand:
            continue

        sec_type = _classify_heading(clean_cand)
        if sec_type:
            # Succeeded matching a known heading
            detected.append(
                _DetectedHeading(
                    section_type=sec_type,
                    heading_text=clean_cand,
                    heading_start=line_start,
                    heading_end=line_end,
                    body_start=line_end,
                )
            )

    if not detected:
        # No headings detected; entire text is one OTHER section
        return [("OTHER", None, 0, len(raw_text))]

    sections: list[tuple[str, str | None, int, int]] = []

    # If there is content before the first heading, treat it as leading OTHER (e.g. Header/Contact)
    if detected[0].heading_start > 0:
        pre_content = raw_text[0 : detected[0].heading_start]
        if pre_content.strip():
            sections.append(("OTHER", None, 0, detected[0].heading_start))

    # Add each detected section
    for i, h in enumerate(detected):
        body_end = detected[i + 1].heading_start if (i + 1 < len(detected)) else len(raw_text)
        sections.append((h.section_type, h.heading_text, h.body_start, body_end))

    return sections


def _chunk_text_span(
    raw_text: str,
    span_start: int,
    span_end: int,
    section_type: str,
    heading: str | None,
    chunk_index_start: int,
    tokenizer: Any,
) -> list[TextChunk]:
    """
    Chunks a text span according to token targets (160-240 tokens) and ~20% overlap.
    Preserves exact character offsets slicing raw_text.
    """
    span_text = raw_text[span_start:span_end]
    if not span_text.strip():
        return []

    # Tokenize with character offset mappings relative to span_text
    encoding = tokenizer(
        span_text,
        add_special_tokens=False,
        return_offsets_mapping=True,
        verbose=False,
    )
    tokens = encoding["input_ids"]
    offset_mapping = encoding["offset_mapping"]

    total_tokens = len(tokens)
    if total_tokens == 0:
        return []

    chunks: list[TextChunk] = []

    # Section below or at target maximum: emit as a single chunk
    if total_tokens <= TARGET_MAX_TOKENS:
        # Find exact non-whitespace boundaries from token offsets
        first_tok_start = offset_mapping[0][0]
        last_tok_end = offset_mapping[-1][1]
        c_start = span_start + first_tok_start
        c_end = span_start + last_tok_end

        # Exact substring from raw_text
        content = raw_text[c_start:c_end]
        chunks.append(
            TextChunk(
                chunk_index=chunk_index_start,
                section_type=section_type,
                heading=heading,
                content=content,
                start_char=c_start,
                end_char=c_end,
                token_count=total_tokens,
                metadata={
                    "sectionType": section_type,
                    "heading": heading,
                    "startChar": c_start,
                    "endChar": c_end,
                    "tokenCount": total_tokens,
                },
            )
        )
        return chunks

    # Section exceeds TARGET_MAX_TOKENS: chunk with overlap
    # Target size ~200 tokens, overlap ~40 tokens (20%)
    target_chunk_size = 200
    overlap_tokens = int(target_chunk_size * DEFAULT_OVERLAP_RATIO)  # 40 tokens

    current_tok_start = 0
    current_index = chunk_index_start

    while current_tok_start < total_tokens:
        tokens_remaining = total_tokens - current_tok_start

        # If remaining tokens fit in a single valid chunk (<= 384)
        if tokens_remaining <= TARGET_MAX_TOKENS:
            # If this is not the first chunk and tokens_remaining < TARGET_MIN_TOKENS:
            # We can either merge with previous chunk if previous + remaining <= 384,
            # or emit as a final overlapping chunk.
            tok_end = total_tokens
        else:
            # We have more than TARGET_MAX_TOKENS left. Attempt to find a natural
            # sentence or paragraph break between TARGET_MIN_TOKENS and TARGET_MAX_TOKENS.
            window_min = current_tok_start + TARGET_MIN_TOKENS
            window_max = min(current_tok_start + TARGET_MAX_TOKENS, total_tokens)

            best_break = window_max
            # Look backwards from window_max down to window_min for a break (\n or punctuation)
            for cand_idx in range(window_max, window_min, -1):
                tok_char_end = offset_mapping[cand_idx - 1][1]
                # Check character right after token in span_text
                if tok_char_end < len(span_text):
                    trailing = span_text[tok_char_end : min(tok_char_end + 3, len(span_text))]
                    if "\n\n" in trailing or "\n" in trailing:
                        best_break = cand_idx
                        break
                    if span_text[tok_char_end - 1 : tok_char_end] in {".", "!", "?"}:
                        best_break = cand_idx
                        break

            tok_end = best_break

        # Compute exact slice character boundaries
        first_tok_start = offset_mapping[current_tok_start][0]
        last_tok_end = offset_mapping[tok_end - 1][1]

        c_start = span_start + first_tok_start
        c_end = span_start + last_tok_end
        content = raw_text[c_start:c_end]
        actual_tokens = tok_end - current_tok_start

        chunks.append(
            TextChunk(
                chunk_index=current_index,
                section_type=section_type,
                heading=heading,
                content=content,
                start_char=c_start,
                end_char=c_end,
                token_count=actual_tokens,
                metadata={
                    "sectionType": section_type,
                    "heading": heading,
                    "startChar": c_start,
                    "endChar": c_end,
                    "tokenCount": actual_tokens,
                },
            )
        )
        current_index += 1

        if tok_end >= total_tokens:
            break

        # Next window starts with overlap
        next_tok_start = tok_end - overlap_tokens
        # Ensure strict forward progress
        if next_tok_start <= current_tok_start:
            next_tok_start = current_tok_start + 1

        current_tok_start = next_tok_start

    return chunks


def chunk_resume_text(
    raw_text: str,
    tokenizer: Any = None,
) -> list[TextChunk]:
    """
    Main entry point for section-aware resume chunking.

    Args:
        raw_text: Canonical extracted text from ParsedResume.rawText.
        tokenizer: Optional AutoTokenizer instance (defaults to singleton all-MiniLM-L6-v2).

    Returns:
        List of TextChunk instances in document order, with exact offsets into raw_text.
    """
    if not raw_text or not raw_text.strip():
        return []

    tok = tokenizer or get_tokenizer()
    sections = _detect_sections(raw_text)

    all_chunks: list[TextChunk] = []
    chunk_counter = 0

    for section_type, heading, body_start, body_end in sections:
        section_chunks = _chunk_text_span(
            raw_text=raw_text,
            span_start=body_start,
            span_end=body_end,
            section_type=section_type,
            heading=heading,
            chunk_index_start=chunk_counter,
            tokenizer=tok,
        )
        for chunk in section_chunks:
            all_chunks.append(chunk)
            chunk_counter += 1

    return all_chunks
