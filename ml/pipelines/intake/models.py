from typing import Any

from ml.models.resume import (
    ContactInfo,
    EducationItem,
    ExperienceItem,
    SkillItem,
)
from pydantic import BaseModel, Field


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
    parsing_metadata: dict[str, Any] = Field(default_factory=dict)
