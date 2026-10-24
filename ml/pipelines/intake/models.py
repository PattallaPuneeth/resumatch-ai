from typing import Any

from ml.models.resume import (
    ContactInfo,
    EducationItem,
    ExperienceItem,
    SkillItem,
)
from pydantic import BaseModel, Field


class AtsHazard(BaseModel):
    code: str = Field(..., description="Hazard code, e.g. MULTI_COLUMN_LAYOUT, TABLES_PRESENT")
    title: str = Field(..., description="Human-readable title")
    description: str = Field(..., description="Explanation of why this is an ATS hazard")
    severity: str = Field(default="MEDIUM", description="LOW, MEDIUM, HIGH")
    location: str | None = Field(default=None, description="Page or section where detected")


class DocumentParseResult(BaseModel):
    raw_text: str
    page_count: int
    extraction_method: str  # TEXT_LAYER | OCR | DOCX
    candidate_name: str | None = None
    contact: ContactInfo
    summary: str | None = None
    skills: list[SkillItem] = Field(default_factory=list)
    experience: list[ExperienceItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    ats_score: float = Field(..., ge=0.0, le=100.0)
    ats_hazards: list[AtsHazard] = Field(default_factory=list)
    parsing_metadata: dict[str, Any] = Field(default_factory=dict)
