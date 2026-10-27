"""
Phase 10A - Item B8: ML Internal Token Enforcement Tests

Table-driven test suite validating internal API token authentication across
EVERY endpoint in the ML FastAPI service:
- Missing token returns 401 or 422
- Invalid token returns 401
- Valid token is authorized (returns route-specific non-auth status: 200, 202, 501)
- Public health check (/health) requires no authentication and returns 200
"""

from unittest.mock import patch, MagicMock
import pytest
from fastapi.testclient import TestClient

from ml.config import settings
from ml.main import app

client = TestClient(app)

# Table of all protected endpoints in ml/main.py
PROTECTED_ROUTES = [
    {
        "method": "POST",
        "url": "/v1/analyses/run",
        "payload": {
            "analysisId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
            "resumeId": "r1r2r3r4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        },
        "expected_authorized_status": 202,
    },
    {
        "method": "POST",
        "url": "/v1/embeddings",
        "payload": {},
        "expected_authorized_status": 501,
    },
    {
        "method": "POST",
        "url": "/v1/parser/extract",
        "payload": {},
        "expected_authorized_status": 501,
    },
    {
        "method": "POST",
        "url": "/v1/matching/rerank",
        "payload": {},
        "expected_authorized_status": 501,
    },
    {
        "method": "POST",
        "url": "/v1/rewriter/bullet",
        "payload": {
            "resumeId": "r1",
            "resumeRawText": "Built microservices using Python and Docker.",
            "originalBullet": "Built microservices using Python and Docker.",
        },
        "expected_authorized_status": 200,
    },
    {
        "method": "POST",
        "url": "/v1/resumes/r1/improvements",
        "payload": {
            "resumeId": "r1",
            "resumeRawText": "Software developer with experience in Python and Docker.",
            "atsScore": 80.0,
        },
        "expected_authorized_status": 200,
    },
    {
        "method": "POST",
        "url": "/v1/matching/score-listings",
        "payload": {
            "resumeId": "r1",
            "listings": [],
        },
        "expected_authorized_status": 200,
    },
]


def test_health_check_public_no_token_required() -> None:
    """Verifies that /health is public and does not require X-Internal-Token."""
    with patch("ml.main.check_database_health") as mock_db:
        mock_db.return_value = {"status": "healthy", "latency_ms": 1.0}
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json()["status"] == "OK"


@pytest.mark.parametrize("route", PROTECTED_ROUTES, ids=[r["url"] for r in PROTECTED_ROUTES])
def test_protected_routes_reject_missing_token(route: dict) -> None:
    """Verifies that requests without X-Internal-Token are rejected (401 or 422)."""
    resp = client.request(
        method=route["method"],
        url=route["url"],
        json=route["payload"],
    )
    # FastAPI returns 422 for missing required header, or 401 if caught by auth dependency
    assert resp.status_code in (401, 422), f"Expected 401 or 422 for {route['url']}, got {resp.status_code}"


@pytest.mark.parametrize("route", PROTECTED_ROUTES, ids=[r["url"] for r in PROTECTED_ROUTES])
def test_protected_routes_reject_invalid_token(route: dict) -> None:
    """Verifies that requests with invalid X-Internal-Token are rejected with 401."""
    resp = client.request(
        method=route["method"],
        url=route["url"],
        json=route["payload"],
        headers={"X-Internal-Token": "invalid-token-value-that-does-not-match"},
    )
    assert resp.status_code == 401, f"Expected 401 for {route['url']}, got {resp.status_code}"
    assert "Invalid or missing X-Internal-Token header" in resp.json()["detail"]


@pytest.mark.parametrize("route", PROTECTED_ROUTES, ids=[r["url"] for r in PROTECTED_ROUTES])
def test_protected_routes_accept_valid_token(route: dict) -> None:
    """Verifies that requests with valid X-Internal-Token pass auth and execute route logic."""
    from ml.pipelines.improvements.models import ImprovementsResponse
    from ml.pipelines.matching.suggestions_scorer import ScoreCandidateListingsResponse
    from ml.pipelines.rewriter.models import RewriterServiceResponse

    with patch("ml.main._rewriter_service.rewrite_bullet") as mock_rewrite, \
         patch("ml.main._improvements_service.generate_improvements") as mock_improve, \
         patch("ml.main._suggestions_scorer.score_listings") as mock_score:

        # Mock service return values to isolate auth from pipeline implementation
        mock_rewrite.return_value = RewriterServiceResponse(
            status="SUCCESS",
            original_bullet=route["payload"].get("originalBullet", "test bullet"),
            options=[],
        )
        mock_improve.return_value = ImprovementsResponse(
            atsScore=80.0,
            atsFixes=[],
            contentFindings=[],
            suggestedRoles=[],
            explanation=None,
            llmStatus="SUCCESS",
        )
        mock_score.return_value = ScoreCandidateListingsResponse(
            resumeId="r1",
            totalScored=0,
            results=[],
        )

        resp = client.request(
            method=route["method"],
            url=route["url"],
            json=route["payload"],
            headers={"X-Internal-Token": settings.internal_api_token},
        )
        assert resp.status_code == route["expected_authorized_status"], (
            f"Expected {route['expected_authorized_status']} for {route['url']}, got {resp.status_code}: {resp.text}"
        )
