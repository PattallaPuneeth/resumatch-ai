"""
Grounding Verifier for LLM Structured Analysis (Phase 4A).
Ensures evidence quotes are strictly grounded in original rawText
and computes fabricated evidence rate.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass

from ml.pipelines.llm.models import (
    LLMAnalysisResponse,
    VerifiedStrengthItem,
)
from ml.pipelines.llm.safety import RedactionResult

logger = logging.getLogger("resumatch-llm-grounding")


class GroundingVerificationError(Exception):
    """Raised when an LLM tier exceeds the fabricated evidence threshold."""

    def __init__(self, message: str, rate: float, dropped: int, total: int) -> None:
        super().__init__(message)
        self.rate = rate
        self.dropped = dropped
        self.total = total


@dataclass
class GroundingVerificationResult:
    verified_strengths: list[VerifiedStrengthItem]
    total_quotes: int
    verified_quotes: int
    dropped_quotes: int
    fabricated_rate: float


def verify_evidence_grounding(
    llm_response: LLMAnalysisResponse,
    redaction: RedactionResult,
    threshold: float = 0.33,
) -> GroundingVerificationResult:
    """
    Verifies every evidence quote against the redacted resume and maps it
    to exact start/end character offsets in original rawText.
    Drops unverifiable or fabricated quotes. If the dropped rate exceeds threshold,
    raises GroundingVerificationError to trigger failover.
    """
    total_quotes = len(llm_response.strengths)
    if total_quotes == 0:
        return GroundingVerificationResult(
            verified_strengths=[],
            total_quotes=0,
            verified_quotes=0,
            dropped_quotes=0,
            fabricated_rate=0.0,
        )

    verified: list[VerifiedStrengthItem] = []
    dropped = 0

    for item in llm_response.strengths:
        quote = item.evidence_quote.strip()
        span = redaction.map_quote_to_original(quote)
        if span is not None:
            start_char, end_char = span
            verified.append(
                VerifiedStrengthItem(
                    point=item.point,
                    requirement=item.requirement,
                    evidence_quote=quote,
                    start_char=start_char,
                    end_char=end_char,
                )
            )
        else:
            quote_hash = hashlib.sha256(quote.encode("utf-8")).hexdigest()[:12]
            logger.warning(
                "Grounding verification rejected evidence quote (len=%d, sha256_prefix=%s): not found or invalid offset",
                len(quote),
                quote_hash,
            )
            dropped += 1

    fabricated_rate = float(dropped) / float(total_quotes)

    if fabricated_rate > threshold:
        raise GroundingVerificationError(
            f"Fabricated evidence rate {fabricated_rate:.2%} exceeded threshold {threshold:.2%} "
            f"({dropped}/{total_quotes} quotes dropped)",
            rate=fabricated_rate,
            dropped=dropped,
            total=total_quotes,
        )

    return GroundingVerificationResult(
        verified_strengths=verified,
        total_quotes=total_quotes,
        verified_quotes=len(verified),
        dropped_quotes=dropped,
        fabricated_rate=fabricated_rate,
    )
