"""
Pydantic models for Phase 4C: Resume-Only Improvements and Role Suggestions.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class AtsFix(BaseModel):
    """Prioritized ATS hazard remediation advice."""

    hazardCode: str
    severity: Literal["HIGH", "MEDIUM", "LOW"]
    issue: str
    recommendation: str
    priority: int


class ContentFinding(BaseModel):
    """Deterministic resume content issue with exact character offsets."""

    type: Literal[
        "MISSING_SECTION",
        "WEAK_PHRASE",
        "OVERLY_LONG_BULLET",
        "NO_ACTION_VERB",
        "NO_METRIC_OR_NUMBER",
        "REPEATED_OPENING_VERB",
    ]
    severity: Literal["HIGH", "MEDIUM", "LOW"]
    message: str
    startChar: int = 0
    endChar: int = 0
    quote: str = ""


class SuggestedRole(BaseModel):
    """ML-ranked suggested career role based on chunk embedding similarity."""

    title: str
    similarityScore: float = Field(ge=0.0, le=1.0)
    matchedSkills: list[str] = Field(default_factory=list)
    missingSkills: list[str] = Field(default_factory=list)


class LLMExplanation(BaseModel):
    """Schema-validated LLM synthesis explaining findings and next steps."""

    summary: str
    prioritizedNextSteps: list[str] = Field(default_factory=list)


class ImprovementsRequest(BaseModel):
    """Internal ML request model."""

    resumeId: str
    resumeRawText: str
    atsScore: float | None = None
    atsHazards: list[dict[str, Any]] | None = None
    candidateSkills: Any | None = None


class ImprovementsResponse(BaseModel):
    """Response returned to backend caller and user."""

    atsScore: float
    atsFixes: list[AtsFix] = Field(default_factory=list)
    contentFindings: list[ContentFinding] = Field(default_factory=list)
    suggestedRoles: list[SuggestedRole] = Field(default_factory=list)
    explanation: LLMExplanation | None = None
    llmStatus: Literal["SUCCESS", "UNAVAILABLE"]
    provider: str | None = None
    model: str | None = None
    tokensPrompt: int | None = None
    tokensCompletion: int | None = None
    latencyMs: int | None = None
