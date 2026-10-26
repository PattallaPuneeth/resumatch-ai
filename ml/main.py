import secrets
from typing import Any

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from ml.config import settings
from ml.db import check_database_health
from ml.models.analysis import AnalysisRequest
from ml.pipelines.improvements.models import (
    ImprovementsRequest,
    ImprovementsResponse,
)
from ml.pipelines.improvements.service import ResumeImprovementsService
from ml.pipelines.matching.suggestions_scorer import (
    ScoreCandidateListingsRequest,
    ScoreCandidateListingsResponse,
    SuggestionsScoringService,
)
from ml.pipelines.rewriter.models import (
    BulletRewriteRequest,
    RewriterServiceResponse,
)
from ml.pipelines.rewriter.service import BulletRewriterService


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "https://app.resumatch.ai",
        "*",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def verify_startup_configuration() -> None:
    token = (settings.internal_api_token or "").strip()
    if settings.env != "test" and (len(token) < 32 or "change_me" in token.lower()):
        raise RuntimeError(
            "INTERNAL_API_TOKEN must be at least 32 characters and cannot contain CHANGE_ME."
        )


def verify_internal_token(x_internal_token: str) -> None:
    expected_token = (settings.internal_api_token or "").strip()
    if (
        not expected_token
        or len(expected_token) < 32
        or "change_me" in expected_token.lower()
        or not secrets.compare_digest(x_internal_token, expected_token)
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token header",
        )


class AnalysisQueuedResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    status: str = "ACCEPTED"
    analysis_id: str = Field(..., alias="analysisId")
    message: str
    stage: str = "QUEUED"


@app.get("/health", status_code=status.HTTP_200_OK)
def health_check() -> dict[str, Any]:
    """
    Returns the health status of the ML service and its dependencies.
    """
    db_status = check_database_health()
    is_ok = db_status.get("status") in ("healthy", "degraded")

    return {
        "status": "OK" if is_ok else "DEGRADED",
        "service": "resumatch-ml",
        "version": "1.0.0",
        "dependencies": {
            "postgres": db_status,
        },
    }


@app.post(
    "/v1/analyses/run",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=AnalysisQueuedResponse,
)
def run_analysis(
    payload: AnalysisRequest,
    x_internal_token: str = Header(..., alias="X-Internal-Token"),
) -> AnalysisQueuedResponse:
    """
    Trigger async multi-stage resume analysis. Validates internal service token.
    """
    verify_internal_token(x_internal_token)

    return AnalysisQueuedResponse(
        status="ACCEPTED",
        analysisId=payload.analysis_id,
        message=f"Analysis pipeline queued for resume {payload.resume_id}",
        stage="QUEUED",
    )


# Feature contract stubs returning 501
@app.post("/v1/embeddings", status_code=status.HTTP_501_NOT_IMPLEMENTED)
def embeddings_stub() -> dict[str, Any]:
    return {
        "statusCode": 501,
        "error": "Not Implemented",
        "message": "Embeddings generation pipeline is not yet implemented. Available in Phase 2.",
    }


@app.post("/v1/parser/extract", status_code=status.HTTP_501_NOT_IMPLEMENTED)
def parser_stub() -> dict[str, Any]:
    return {
        "statusCode": 501,
        "error": "Not Implemented",
        "message": "ATS resume parsing pipeline is not yet implemented. Available in Phase 2.",
    }


@app.post("/v1/matching/rerank", status_code=status.HTTP_501_NOT_IMPLEMENTED)
def rerank_stub() -> dict[str, Any]:
    return {
        "statusCode": 501,
        "error": "Not Implemented",
        "message": "Cross-encoder reranking pipeline is not yet implemented. Available in Phase 2.",
    }


_rewriter_service = BulletRewriterService()



@app.post(
    "/v1/rewriter/bullet",
    status_code=status.HTTP_200_OK,
    response_model=RewriterServiceResponse,
)
async def rewrite_bullet_endpoint(
    payload: BulletRewriteRequest,
    x_internal_token: str = Header(..., alias="X-Internal-Token"),
) -> RewriterServiceResponse:
    """
    Fact-grounded STAR bullet rewriter endpoint (Phase 4B).
    Validates internal service token and enforces strict factual grounding.
    """
    verify_internal_token(x_internal_token)

    try:
        result = await _rewriter_service.rewrite_bullet(payload)
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(ve),
        ) from ve

    if result.status == "HALLUCINATION_DETECTED":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "HALLUCINATION_DETECTED: No rewritten options could be verified "
                "against source facts."
            ),
        )

    return result


_improvements_service = ResumeImprovementsService()


@app.post(
    "/v1/resumes/{resume_id}/improvements",
    status_code=status.HTTP_200_OK,
    response_model=ImprovementsResponse,
)
async def resume_improvements_endpoint(
    resume_id: str,
    payload: ImprovementsRequest,
    x_internal_token: str = Header(..., alias="X-Internal-Token"),
) -> ImprovementsResponse:
    """
    Resume-only improvements and role suggestions endpoint (Phase 4C).
    Validates internal service token and returns deterministic findings and ML-ranked roles.
    """
    verify_internal_token(x_internal_token)
    if payload.resumeId != resume_id:
        payload.resumeId = resume_id

    return await _improvements_service.generate_improvements(payload)


_suggestions_scorer = SuggestionsScoringService()


@app.post(
    "/v1/matching/score-listings",
    status_code=status.HTTP_200_OK,
    response_model=ScoreCandidateListingsResponse,
)
def score_candidate_listings_endpoint(
    payload: ScoreCandidateListingsRequest,
    x_internal_token: str = Header(..., alias="X-Internal-Token"),
) -> ScoreCandidateListingsResponse:
    """
    Candidate job listing scoring endpoint (Phase 7).
    Validates internal service token and calculates deterministic match scores
    and skill gap alignments against a candidate resume.
    """
    verify_internal_token(x_internal_token)
    try:
        return _suggestions_scorer.score_listings(payload)
    except ValueError as ve:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(ve),
        ) from ve
