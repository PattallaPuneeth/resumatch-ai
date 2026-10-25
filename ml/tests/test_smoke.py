from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from ml.config import settings
from ml.main import app
from ml.models.analysis import StageEvent
from ml.models.matching import EvidenceItem, MatchResult, ScoreComponents
from ml.models.resume import (
    CertificationItem,
    ContactInfo,
    EducationItem,
    ExperienceItem,
    FieldConfidence,
    ParsedResume,
    SkillItem,
    SourceSpan,
)

client = TestClient(app)


def test_health_check_ok() -> None:
    with patch("ml.main.check_database_health") as mock_db:
        mock_db.return_value = {
            "status": "healthy",
            "latency_ms": 1.2,
            "pgvector_extension": "installed",
        }
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "OK"
        assert data["service"] == "resumatch-ml"
        assert data["dependencies"]["postgres"]["status"] == "healthy"


def test_run_analysis_unauthorized() -> None:
    payload = {
        "analysisId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "resumeId": "r1r2r3r4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    }
    response = client.post("/v1/analyses/run", json=payload)
    assert response.status_code == 422  # missing header


def test_run_analysis_invalid_token() -> None:
    payload = {
        "analysisId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "resumeId": "r1r2r3r4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    }
    response = client.post(
        "/v1/analyses/run",
        json=payload,
        headers={"X-Internal-Token": "wrong-token"},
    )
    assert response.status_code == 401


def test_run_analysis_success() -> None:
    payload = {
        "analysisId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
        "resumeId": "r1r2r3r4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    }
    response = client.post(
        "/v1/analyses/run",
        json=payload,
        headers={"X-Internal-Token": settings.internal_api_token},
    )
    assert response.status_code == 202
    data = response.json()
    assert data["status"] == "ACCEPTED"
    assert data["analysisId"] == payload["analysisId"]
    assert data["stage"] == "QUEUED"


def test_pydantic_parsed_resume_schema() -> None:
    span = SourceSpan(start_char=0, end_char=16, source_text="Puneeth Pattalla")
    conf = FieldConfidence(score=0.98, source_span=span)
    contact = ContactInfo(
        name="Puneeth Pattalla",
        name_confidence=conf,
        email="puneeth@example.com",
    )
    exp = ExperienceItem(
        company="Antigravity",
        title="ML Engineer",
        current=True,
        bullets=["Designed pgvector indexing", "Implemented hybrid RRF search"],
    )
    skill = SkillItem(name="Python", category="languages")
    edu = EducationItem(institution="MIT", degree="B.S. in CS")
    cert = CertificationItem(name="TensorFlow Developer")

    parsed = ParsedResume(
        resume_id="res-123",
        raw_text="Puneeth Pattalla\nML Engineer...",
        contact=contact,
        experience=[exp],
        skills=[skill],
        education=[edu],
        certifications=[cert],
        overall_confidence=0.95,
    )

    assert parsed.resume_id == "res-123"
    assert parsed.contact.name == "Puneeth Pattalla"
    assert len(parsed.experience) == 1
    assert parsed.experience[0].company == "Antigravity"
    assert len(parsed.skills) == 1


def test_pydantic_match_result_schema() -> None:
    result = MatchResult(
        score=92.5,
        components=ScoreComponents(
            bm25Score=8.4,
            vectorCosineScore=0.89,
            rrfScore=0.032,
            crossEncoderScore=0.94,
        ),
        matchedSkills=["Python", "PostgreSQL", "FastAPI"],
        gaps=["Docker"],
        evidence=[
            EvidenceItem(
                chunkId="c-1",
                snippet="Experienced with FastAPI and pgvector",
                relevanceScore=0.94,
                reason="Direct semantic match on tech stack",
            )
        ],
    )

    assert result.score == 92.5
    assert result.components.cross_encoder_score == 0.94
    assert len(result.evidence) == 1


def test_stage_event_schema() -> None:
    event = StageEvent(
        analysisId="a-1",
        stage="MATCHING",
        progress=0.75,
        message="Executing cross-encoder reranking",
    )
    assert event.analysis_id == "a-1"
    assert event.progress == 0.75


def test_stubs_501() -> None:
    endpoints = [
        "/v1/embeddings",
        "/v1/parser/extract",
        "/v1/matching/rerank",
    ]
    for ep in endpoints:
        res = client.post(ep)
        assert res.status_code == 501
        data = res.json()
        assert data["statusCode"] == 501
        assert data["error"] == "Not Implemented"


def test_rewriter_endpoint_auth() -> None:
    """Verifies that /v1/rewriter/bullet requires valid X-Internal-Token."""
    payload = {
        "resumeId": "11111111-1111-4111-a111-111111111111",
        "originalBullet": "Managed microservices",
        "resumeRawText": "Managed microservices",
    }
    # Missing header -> 422
    res_missing = client.post("/v1/rewriter/bullet", json=payload)
    assert res_missing.status_code == 422

    # Invalid token -> 401
    res_invalid = client.post(
        "/v1/rewriter/bullet",
        json=payload,
        headers={"X-Internal-Token": "invalid-token"},
    )
    assert res_invalid.status_code == 401


def test_rewriter_endpoint_fails_closed_when_token_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verifies that if INTERNAL_API_TOKEN is unset or empty, requests are rejected (never open)."""
    payload = {
        "resumeId": "11111111-1111-4111-a111-111111111111",
        "originalBullet": "Managed microservices",
        "resumeRawText": "Managed microservices",
    }
    # Case 1: Empty string
    monkeypatch.setattr(settings, "internal_api_token", "")
    res_empty = client.post(
        "/v1/rewriter/bullet",
        json=payload,
        headers={"X-Internal-Token": ""},
    )
    assert res_empty.status_code == 401

    # Case 2: Whitespace only
    monkeypatch.setattr(settings, "internal_api_token", "   ")
    res_whitespace = client.post(
        "/v1/rewriter/bullet",
        json=payload,
        headers={"X-Internal-Token": "   "},
    )
    assert res_whitespace.status_code == 401

    # Case 3: None/unset
    monkeypatch.setattr(settings, "internal_api_token", None)
    res_none = client.post(
        "/v1/rewriter/bullet",
        json=payload,
        headers={"X-Internal-Token": "some-token"},
    )
    assert res_none.status_code == 401

