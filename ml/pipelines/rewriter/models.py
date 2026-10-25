"""
Pydantic data models for Fact-Grounded STAR Bullet Rewriter (Phase 4B).
"""

from __future__ import annotations

from typing import Literal

from ml.pipelines.llm.models import LLMRewriterOption, LLMRewriterResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

__all__ = [
    "BulletRewriteRequest",
    "EvidenceSpan",
    "VerifiedRewriteOption",
    "RewriterServiceResponse",
    "LLMRewriterOption",
    "LLMRewriterResponse",
]


class BulletRewriteRequest(BaseModel):
    """Internal ML request for bullet rewriting."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    resume_id: str
    original_bullet: str = Field(..., min_length=1, max_length=500)
    resume_raw_text: str
    target_skill: str | None = None
    job_text: str | None = None


class EvidenceSpan(BaseModel):
    """Exact character span grounding an evidence quote in source rawText."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    start_char: int
    end_char: int
    quote: str


class VerifiedRewriteOption(BaseModel):
    """Verified, grounded STAR rewrite option returned to client."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    text: str
    evidence_spans: list[EvidenceSpan] = Field(default_factory=list)
    needs_user_input: bool = False


class RewriterServiceResponse(BaseModel):
    """Complete rewriter service response."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    status: Literal["SUCCESS", "HALLUCINATION_DETECTED"]
    original_bullet: str
    options: list[VerifiedRewriteOption] = Field(default_factory=list)
    provider: str | None = None
    model: str | None = None
    tokens_prompt: int = 0
    tokens_completion: int = 0
    latency_ms: int = 0
