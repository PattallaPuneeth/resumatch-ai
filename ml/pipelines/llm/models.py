"""
Pydantic Schemas for LLM Structured Analysis (Phase 4A).
Defines LLM-generated extraction schemas and UI-ready composite analysis models.
"""

from __future__ import annotations

from typing import Literal

from ml.pipelines.llm.config import PROMPT_VERSION
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class StrengthItem(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)

    point: str = Field(..., description="Key technical qualification or capability")
    requirement: str = Field(..., description="Target job requirement matched")
    evidence_quote: str = Field(
        ...,
        description="Exact quote from resume text backing the qualification",
    )


class GapItem(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)

    requirement: str = Field(..., description="Job requirement not met or partially met")
    importance: Literal["must", "nice"] = Field(
        ...,
        description="Requirement priority: must-have vs nice-to-have",
    )
    explanation: str = Field(..., description="Why the candidate profile is lacking")
    suggested_fix: str = Field(
        ...,
        description="Actionable suggestion for the candidate to address the gap",
    )


class PrioritizedImprovement(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)

    action: str = Field(..., description="Concrete step to improve match or resume alignment")
    reason: str = Field(..., description="Impact of taking this step")


class LLMAnalysisResponse(BaseModel):
    """Schema expected from LLM response. Strictly forbids any score-like fields."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, alias_generator=to_camel)

    summary: str = Field(..., description="Concise executive synthesis of candidate suitability")
    strengths: list[StrengthItem] = Field(default_factory=list)
    gaps: list[GapItem] = Field(default_factory=list)
    prioritized_improvements: list[PrioritizedImprovement] = Field(default_factory=list)


class VerifiedStrengthItem(BaseModel):
    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    point: str
    requirement: str
    evidence_quote: str
    start_char: int
    end_char: int


class StructuredAnalysisResult(BaseModel):
    """Final, UI-ready analysis payload combining verified LLM insights and deterministic scores."""

    model_config = ConfigDict(populate_by_name=True, alias_generator=to_camel)

    summary: str
    strengths: list[VerifiedStrengthItem]
    gaps: list[GapItem]
    prioritized_improvements: list[PrioritizedImprovement]

    # Deterministic metrics injected strictly by code (never editable by LLM)
    match_score: float = Field(..., description="Deterministic ML match score (0-100)")
    ats_score: float | None = Field(default=None, description="ATS parseability score (0-100)")
    verdict_band: Literal["strong", "medium", "weak"] = Field(
        ...,
        description="Verdict band derived from 75/45 calibration thresholds",
    )
    matched_skills: list[str] = Field(default_factory=list)
    missing_skills: list[str] = Field(default_factory=list)
    partial_skills: list[str] = Field(default_factory=list)

    # Execution and Safety Metadata
    llm_status: Literal["SUCCESS", "UNAVAILABLE", "FAILED"]
    provider: str | None = None
    model: str | None = None
    prompt_version: str = PROMPT_VERSION
    tokens_prompt: int = 0
    tokens_completion: int = 0
    latency_ms: int = 0
    fabricated_evidence_rate: float = 0.0
    injection_suspected: bool = False


class LLMRewriterOption(BaseModel):
    """Raw rewrite option as parsed from LLM JSON response."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True, alias_generator=to_camel)

    text: str
    evidence_quotes: list[str] = Field(default_factory=list)
    needs_user_input: bool = False


class LLMRewriterResponse(BaseModel):
    """Raw LLM payload schema for bullet rewriter."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    options: list[LLMRewriterOption] = Field(default_factory=list)


class LLMImprovementsOutput(BaseModel):
    """Raw LLM payload schema for resume improvements synthesis."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True, alias_generator=to_camel)

    summary: str
    prioritized_next_steps: list[str] = Field(default_factory=list, alias="prioritizedNextSteps")
    evidence_quotes: list[str] = Field(default_factory=list, alias="evidenceQuotes")


