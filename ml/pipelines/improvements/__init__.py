"""
Phase 4C: Resume-only Improvements and Role Suggestions.
Stateless, ML-ranked role suggestions, deterministic ATS fixes and content findings,
and schema-validated LLM synthesis with grounding verification.
"""

from ml.pipelines.improvements.models import (
    AtsFix,
    ContentFinding,
    ImprovementsRequest,
    ImprovementsResponse,
    SuggestedRole,
)
from ml.pipelines.improvements.service import ResumeImprovementsService

__all__ = [
    "AtsFix",
    "ContentFinding",
    "ImprovementsRequest",
    "ImprovementsResponse",
    "ResumeImprovementsService",
    "SuggestedRole",
]
