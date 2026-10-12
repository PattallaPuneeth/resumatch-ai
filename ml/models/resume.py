from pydantic import BaseModel, ConfigDict, Field


class SourceSpan(BaseModel):
    start_char: int = Field(..., ge=0, description="Start character offset in raw text")
    end_char: int = Field(..., ge=0, description="End character offset in raw text")
    source_text: str = Field(..., description="Extracted substring from raw text")


class FieldConfidence(BaseModel):
    score: float = Field(..., ge=0.0, le=1.0, description="Confidence score between 0.0 and 1.0")
    source_span: SourceSpan | None = Field(
        default=None, description="Optional text span where entity was extracted"
    )


class ContactInfo(BaseModel):
    name: str | None = None
    name_confidence: FieldConfidence | None = None
    email: str | None = None
    email_confidence: FieldConfidence | None = None
    phone: str | None = None
    phone_confidence: FieldConfidence | None = None
    location: str | None = None
    linkedin_url: str | None = None
    github_url: str | None = None
    portfolio_url: str | None = None
    span: SourceSpan | None = None


class ExperienceItem(BaseModel):
    company: str
    title: str
    start_date: str | None = None
    end_date: str | None = None
    current: bool = False
    location: str | None = None
    bullets: list[str] = Field(default_factory=list)
    confidence: FieldConfidence | None = None
    span: SourceSpan | None = None


class SkillItem(BaseModel):
    name: str
    category: str = Field(
        default="tools", description="e.g. languages, frameworks, tools, soft_skills"
    )
    level: str | None = None
    confidence: FieldConfidence | None = None
    span: SourceSpan | None = None


class EducationItem(BaseModel):
    institution: str
    degree: str | None = None
    field_of_study: str | None = None
    start_year: int | None = None
    graduation_year: int | None = None
    gpa: float | None = None
    confidence: FieldConfidence | None = None
    span: SourceSpan | None = None


class CertificationItem(BaseModel):
    name: str
    issuer: str | None = None
    issue_date: str | None = None
    expiration_date: str | None = None
    confidence: FieldConfidence | None = None
    span: SourceSpan | None = None


class ParsedResume(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    resume_id: str
    raw_text: str
    contact: ContactInfo
    experience: list[ExperienceItem] = Field(default_factory=list)
    skills: list[SkillItem] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)
    certifications: list[CertificationItem] = Field(default_factory=list)
    overall_confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    parser_version: str = Field(default="1.0.0")
