from pydantic import BaseModel, ConfigDict, Field


class ScoreComponents(BaseModel):
    bm25_score: float | None = Field(default=None, alias="bm25Score")
    vector_cosine_score: float | None = Field(default=None, alias="vectorCosineScore")
    rrf_score: float | None = Field(default=None, alias="rrfScore")
    cross_encoder_score: float | None = Field(default=None, alias="crossEncoderScore")

    model_config = ConfigDict(populate_by_name=True)


class EvidenceItem(BaseModel):
    chunk_id: str = Field(..., alias="chunkId")
    snippet: str
    relevance_score: float = Field(..., alias="relevanceScore", ge=0.0, le=1.0)
    reason: str

    model_config = ConfigDict(populate_by_name=True)


class MatchResult(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    score: float = Field(..., ge=0.0, le=100.0, description="Overall match score (0-100)")
    components: ScoreComponents = Field(default_factory=ScoreComponents)
    matched_skills: list[str] = Field(default_factory=list, alias="matchedSkills")
    gaps: list[str] = Field(default_factory=list, description="Missing required job skills")
    evidence: list[EvidenceItem] = Field(
        default_factory=list,
        description="Text spans backing the match score",
    )

