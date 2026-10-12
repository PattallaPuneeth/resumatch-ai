from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    analysis_id: str = Field(
        ...,
        alias="analysisId",
        description="Unique UUID for analysis session",
    )
    resume_id: str = Field(..., alias="resumeId", description="Target resume UUID")
    job_id: str | None = Field(default=None, alias="jobId", description="Optional target job UUID")
    raw_text: str | None = Field(
        default=None,
        alias="rawText",
        description="Optional raw text for analysis",
    )
    options: dict[str, Any] = Field(
        default_factory=dict,
        description="Pipeline configuration options",
    )


class StageEvent(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    analysis_id: str = Field(..., alias="analysisId", description="Analysis job ID")
    stage: str = Field(
        ...,
        description="Current pipeline stage (e.g. INTAKE, EMBEDDINGS, MATCHING, REWRITER)",
    )
    progress: float = Field(..., ge=0.0, le=1.0, description="Progress between 0.0 and 1.0")
    message: str = Field(..., description="Human-readable stage description")

