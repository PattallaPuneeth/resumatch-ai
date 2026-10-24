from typing import Any

from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from ml.config import settings
from ml.db import check_database_health
from ml.models.analysis import AnalysisRequest

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
    if x_internal_token != settings.internal_api_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token header",
        )

    return AnalysisQueuedResponse(
        status="ACCEPTED",
        analysis_id=payload.analysis_id,
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


@app.post("/v1/rewriter/bullet", status_code=status.HTTP_501_NOT_IMPLEMENTED)
def rewriter_stub() -> dict[str, Any]:
    return {
        "statusCode": 501,
        "error": "Not Implemented",
        "message": (
            "Fact-grounded bullet rewriting pipeline is not yet implemented. Available in Phase 2."
        ),
    }
