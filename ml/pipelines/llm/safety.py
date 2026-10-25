"""
Safety Layer for LLM Gateway (Phase 4A).
Implements bidirectional PII redaction with character-offset mapping back to original rawText,
and prompt-injection detection.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field

PLACEHOLDER_NAME = "[CANDIDATE_NAME]"
PLACEHOLDER_EMAIL = "[EMAIL_ADDRESS]"
PLACEHOLDER_PHONE = "[PHONE_NUMBER]"
PLACEHOLDER_URL = "[WEB_URL]"
PLACEHOLDER_ADDRESS = "[STREET_ADDRESS]"
PLACEHOLDER_DOB = "[DATE_OF_BIRTH]"
PLACEHOLDER_BIAS = "[BIAS_CUE]"

ALL_PLACEHOLDERS = {
    PLACEHOLDER_NAME,
    PLACEHOLDER_EMAIL,
    PLACEHOLDER_PHONE,
    PLACEHOLDER_URL,
    PLACEHOLDER_ADDRESS,
    PLACEHOLDER_DOB,
    PLACEHOLDER_BIAS,
}

# Regex patterns for PII
RE_EMAIL = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b")
RE_PHONE = re.compile(
    r"(?:(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{1,5})?"
)
RE_URL = re.compile(
    r"(?:https?://|www\.)\S+|(?:github|linkedin|twitter|x)\.com/\S+",
    re.IGNORECASE,
)
RE_ADDRESS = re.compile(
    r"\b\d{1,5}\s+[A-Za-z\s.,]{2,30}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Circle|Cir|Terrace|Ter|Place|Pl|Parkway|Pkwy|Plaza)\b",
    re.IGNORECASE,
)
RE_DOB = re.compile(
    r"\b(?:DOB|Date of Birth|Birthdate)[\s:]+\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b",
    re.IGNORECASE,
)
RE_BIAS_CUES = re.compile(
    r"\b(?:Mr\.|Mrs\.|Ms\.|he/him|she/her|they/them|married|unmarried|single|"
    r"divorced|widowed|photo attached|headshot attached|visa status|"
    r"US citizen|green card holder|Indian citizen)\b",
    re.IGNORECASE,
)

# Injection detection patterns
RE_INJECTION_PATTERNS = [
    re.compile(
        r"ignore\s+(?:all\s+)?(?:(?:previous|prior|above)\s+)?instructions.*",
        re.IGNORECASE,
    ),
    re.compile(
        r"disregard\s+(?:all\s+)?(?:(?:previous|prior|above)\s+)?instructions.*",
        re.IGNORECASE,
    ),
    re.compile(r"system\s+prompt.*", re.IGNORECASE),
    re.compile(r"you\s+are\s+now\s+(?:a|an)\b.*", re.IGNORECASE),
    re.compile(r"give\s+(?:this\s+candidate\s+)?a\s+perfect\s+score.*", re.IGNORECASE),
    re.compile(r"say\s+(?:i|they|he|she)\s+(?:ha(?:ve|s)|am)\s+\d+\s+years.*", re.IGNORECASE),
    re.compile(r"add\s+\d+\s+years\s+(?:of\s+)?experience.*", re.IGNORECASE),
    re.compile(r"forget\s+(?:all\s+)?(?:rules|instructions).*", re.IGNORECASE),
    re.compile(r"bypass\s+(?:verification|grounding|safety).*", re.IGNORECASE),
]


@dataclass
class RedactionResult:
    original_text: str
    redacted_text: str
    offset_map: list[int] = field(default_factory=list)
    placeholders_used: set[str] = field(default_factory=set)
    replacement_map: dict[str, str] = field(default_factory=dict)

    @property
    def mapping(self) -> dict[str, str]:
        """Alias for replacement_map mapping placeholders to original strings."""
        return self.replacement_map

    def map_quote_to_original(self, quote: str) -> tuple[int, int] | None:
        """
        Locates the quote in redacted_text and maps its start/end offsets back
        to original_text, ensuring exact string identity original_text[start:end] == quote.
        Rejects quotes containing any redaction placeholder.
        """
        if not quote or not quote.strip():
            return None

        # Disallow placeholders in quotes
        for p in ALL_PLACEHOLDERS:
            if p in quote:
                return None

        start_in_redacted = self.redacted_text.find(quote)
        if start_in_redacted == -1:
            return None

        end_in_redacted = start_in_redacted + len(quote)

        if start_in_redacted >= len(self.offset_map) or (end_in_redacted - 1) >= len(
            self.offset_map
        ):
            return None

        orig_start = self.offset_map[start_in_redacted]
        orig_end = self.offset_map[end_in_redacted - 1] + 1

        if orig_start < 0 or orig_end < 0 or orig_start >= orig_end:
            return None

        # Strictly verify exact rawText slice match
        candidate = self.original_text[orig_start:orig_end]
        if candidate == quote:
            return orig_start, orig_end

        return None


def detect_prompt_injection(text: str) -> bool:
    """Returns True if any prompt-injection heuristic matches."""
    for pattern in RE_INJECTION_PATTERNS:
        if pattern.search(text):
            return True
    return False


def strip_prompt_injection(text: str) -> str:
    """Strips known prompt injection command patterns from untrusted candidate text."""
    stripped = text
    for pattern in RE_INJECTION_PATTERNS:
        stripped = pattern.sub("", stripped)
    return stripped


def redact_pii(
    text: str,
    candidate_name: str | None = None,
) -> RedactionResult:
    """
    Applies comprehensive PII redaction with character-offset mapping.
    Replaces candidate names, emails, phones, URLs, addresses, DOB, and bias cues
    with stable placeholders.
    """
    if not text:
        return RedactionResult(
            original_text="", redacted_text="", offset_map=[], placeholders_used=set()
        )

    # Build spans to replace: list of (start, end, placeholder)
    spans: list[tuple[int, int, str]] = []

    # 1. Candidate Name (from parser or header heuristic)
    if candidate_name and len(candidate_name.strip()) >= 2:
        name_clean = candidate_name.strip()
        pattern = re.compile(rf"\b{re.escape(name_clean)}\b", re.IGNORECASE)
        for m in pattern.finditer(text):
            spans.append((m.start(), m.end(), PLACEHOLDER_NAME))

    # 2. Email Addresses
    for m in RE_EMAIL.finditer(text):
        spans.append((m.start(), m.end(), PLACEHOLDER_EMAIL))

    # 3. Phone Numbers
    for m in RE_PHONE.finditer(text):
        match_str = m.group()
        # Ensure at least 7 digits to avoid matching short numbers or dates
        digits_only = re.sub(r"\D", "", match_str)
        if len(digits_only) >= 7:
            spans.append((m.start(), m.end(), PLACEHOLDER_PHONE))

    # 4. URLs and Socials
    for m in RE_URL.finditer(text):
        spans.append((m.start(), m.end(), PLACEHOLDER_URL))

    # 5. Street Addresses
    for m in RE_ADDRESS.finditer(text):
        spans.append((m.start(), m.end(), PLACEHOLDER_ADDRESS))

    # 6. Date of Birth
    for m in RE_DOB.finditer(text):
        spans.append((m.start(), m.end(), PLACEHOLDER_DOB))

    # 7. Bias Cues
    for m in RE_BIAS_CUES.finditer(text):
        spans.append((m.start(), m.end(), PLACEHOLDER_BIAS))

    # Sort spans by start asc, length desc, resolve overlapping spans
    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    non_overlapping: list[tuple[int, int, str]] = []
    current_end = -1
    for start, end, ph in spans:
        if start >= current_end:
            non_overlapping.append((start, end, ph))
            current_end = end

    # Construct redacted text and offset mapping
    redacted_chars: list[str] = []
    offset_map: list[int] = []
    placeholders_used: set[str] = set()
    replacement_map: dict[str, str] = {}
    counts: dict[str, int] = {}

    orig_idx = 0
    for start, end, placeholder in non_overlapping:
        orig_slice = text[start:end]
        replacement_map[placeholder] = orig_slice
        base = placeholder.strip("[]")
        counts[base] = counts.get(base, 0) + 1
        replacement_map[f"[{base}_{counts[base]}]"] = orig_slice
        if "EMAIL" in base:
            replacement_map[f"[EMAIL_{counts[base]}]"] = orig_slice
        elif "PHONE" in base:
            replacement_map[f"[PHONE_{counts[base]}]"] = orig_slice
        elif "NAME" in base:
            replacement_map[f"[NAME_{counts[base]}]"] = orig_slice
        elif "URL" in base:
            replacement_map[f"[URL_{counts[base]}]"] = orig_slice

        # Append untouched characters up to span
        while orig_idx < start:
            redacted_chars.append(text[orig_idx])
            offset_map.append(orig_idx)
            orig_idx += 1

        # Append placeholder
        placeholders_used.add(placeholder)
        for _ in placeholder:
            redacted_chars.append(_)
            offset_map.append(-1)  # Invalid marker for placeholder positions

        orig_idx = end

    # Append trailing untouched characters
    while orig_idx < len(text):
        redacted_chars.append(text[orig_idx])
        offset_map.append(orig_idx)
        orig_idx += 1

    return RedactionResult(
        original_text=text,
        redacted_text="".join(redacted_chars),
        offset_map=offset_map,
        placeholders_used=placeholders_used,
        replacement_map=replacement_map,
    )


def generate_delimiter_tag() -> tuple[str, str]:
    """Generates a cryptographically random delimiter pair for untrusted data framing."""
    token = secrets.token_hex(8)
    return f"<<<DATA_{token}>>>", f"<<</DATA_{token}>>>"
