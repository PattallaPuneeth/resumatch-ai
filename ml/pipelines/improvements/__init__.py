"""
Phase 4C: Resume-only Improvements and Role Suggestions.
Stateless, ML-ranked role suggestions, deterministic content findings,
and schema-validated LLM synthesis with grounding verification.
"""

from ml.pipelines.improvements.models import (
    ContentFinding,
    ImprovementsRequest,
    ImprovementsResponse,
    SuggestedRole,
)
from ml.pipelines.improvements.service import ResumeImprovementsService

__all__ = [
    "ContentFinding",
    "ImprovementsRequest",
    "ImprovementsResponse",
    "ResumeImprovementsService",
    "SuggestedRole",
]
