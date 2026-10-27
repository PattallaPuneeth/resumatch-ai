"""
Security Regression Test for SEC-01 (Zero PII / Evidence Quotes in Logs).
Captures ALL log output (caplog at DEBUG across all loggers) while running:
1. Grounding rejection path (verify_evidence_grounding)
2. Bullet rewriter path (BulletRewriterService)
3. Resume improvements path (ResumeImprovementsService)

Fails if any distinctive sentinel string appears in any log record.
"""

from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from ml.pipelines.improvements.models import ImprovementsRequest
from ml.pipelines.improvements.service import ResumeImprovementsService
from ml.pipelines.llm.gateway import (
    ImprovementsGatewayResult,
    LLMGateway,
    RewriterGatewayResult,
)
from ml.pipelines.llm.grounding import verify_evidence_grounding
from ml.pipelines.llm.models import (
    LLMAnalysisResponse,
    LLMImprovementsOutput,
    LLMRewriterResponse,
    StrengthItem,
)
from ml.pipelines.llm.safety import RedactionResult
from ml.pipelines.rewriter.models import BulletRewriteRequest, LLMRewriterOption
from ml.pipelines.rewriter.service import BulletRewriterService

SENTINEL_GROUNDING_QUOTE = "SENTINEL_CONFIDENTIAL_GROUNDING_QUOTE_ALPHA_99"
SENTINEL_REWRITER_BULLET = "SENTINEL_SECRET_PROJECT_PAYMENT_METRIC_BETA_88"
SENTINEL_IMPROVEMENTS_CONTENT = "SENTINEL_INTERNAL_MERGER_EXPERIENCE_GAMMA_77"


def test_sec01_grounding_rejection_logs_no_plaintext_quotes(caplog: pytest.LogCaptureFixture) -> None:
    """Proves that rejected grounding evidence quotes are never logged in plaintext."""
    caplog.set_level(logging.DEBUG)

    raw_text = "Standard resume text without any confidential quote."
    redaction = RedactionResult(original_text=raw_text, redacted_text=raw_text, replacement_map={})

    # Fabricated / ungrounded item containing the sentinel quote
    llm_resp = LLMAnalysisResponse(
        summary="Candidate analysis summary",
        strengths=[
            StrengthItem(
                point="Engineered mission critical distributed transaction ledger",
                requirement="Distributed systems",
                evidence_quote=f"Confidential: {SENTINEL_GROUNDING_QUOTE}",
            )
        ],
        gaps=[],
        prioritized_improvements=[],
    )

    # Verify grounding with threshold 1.0 to drop the quote without throwing
    result = verify_evidence_grounding(llm_response=llm_resp, redaction=redaction, threshold=1.0)
    assert result.dropped_quotes == 1

    # Assert NO log record contains the sentinel string
    for record in caplog.records:
        assert SENTINEL_GROUNDING_QUOTE not in record.getMessage(), (
            f"SEC-01 REGRESSION DETECTED: Grounding quote found in log message: {record.getMessage()}"
        )


@pytest.mark.asyncio
async def test_sec01_bullet_rewriter_logs_no_sentinel_strings(caplog: pytest.LogCaptureFixture) -> None:
    """Proves that bullet rewriter pipeline never leaks raw bullet text or sentinel quotes into logs."""
    caplog.set_level(logging.DEBUG)

    original_bullet = f"Built distributed payment system for {SENTINEL_REWRITER_BULLET}."
    raw_text = f"Experience:\n- {original_bullet}\nSkills: Python, Redis."

    mock_gw = MagicMock(spec=LLMGateway)
    mock_gw.execute_rewriter = AsyncMock(
        return_value=RewriterGatewayResult(
            llm_response=LLMRewriterResponse(
                options=[
                    LLMRewriterOption(
                        text=f"Engineered high-throughput payments with Redis for {SENTINEL_REWRITER_BULLET}.",
                        evidence_quotes=[original_bullet],
                        needs_user_input=False,
                    )
                ]
            ),
            provider="mock",
            model="mock-model",
            tokens_prompt=100,
            tokens_completion=50,
            latency_ms=120,
            cached=False,
        )
    )

    service = BulletRewriterService(gateway=mock_gw)
    request = BulletRewriteRequest(
        original_bullet=original_bullet,
        resume_raw_text=raw_text,
        resume_id="00000000-0000-0000-0000-000000000001",
    )

    response = await service.rewrite_bullet(request)
    assert response is not None

    for record in caplog.records:
        assert SENTINEL_REWRITER_BULLET not in record.getMessage(), (
            f"SEC-01 REGRESSION DETECTED: Raw bullet sentinel found in log record: {record.getMessage()}"
        )


@pytest.mark.asyncio
async def test_sec01_improvements_logs_no_sentinel_strings(caplog: pytest.LogCaptureFixture) -> None:
    """Proves that resume improvements pipeline never leaks raw candidate content into logs."""
    caplog.set_level(logging.DEBUG)

    raw_text = f"Work Experience:\nLed architecture of {SENTINEL_IMPROVEMENTS_CONTENT}."
    mock_gw = MagicMock(spec=LLMGateway)
    mock_gw.execute_improvements = AsyncMock(
        return_value=ImprovementsGatewayResult(
            llm_response=LLMImprovementsOutput(
                summary="Solid background in distributed systems.",
                prioritizedNextSteps=["Add quantified business outcomes."],
                evidenceQuotes=[f"Fabricated claim: {SENTINEL_IMPROVEMENTS_CONTENT}"],
            ),
            provider="mock-provider",
            model="mock-model",
            tokens_prompt=120,
            tokens_completion=40,
            latency_ms=200,
            cached=False,
        )
    )

    service = ResumeImprovementsService(gateway=mock_gw)
    request = ImprovementsRequest(
        resumeId="00000000-0000-0000-0000-000000000001",
        resumeRawText=raw_text,
        atsScore=85.0,
        atsHazards=[],
        candidateSkills=["python", "redis"],
    )

    response = await service.generate_improvements(request)
    assert response is not None

    for record in caplog.records:
        assert SENTINEL_IMPROVEMENTS_CONTENT not in record.getMessage(), (
            f"SEC-01 REGRESSION DETECTED: Candidate text sentinel found in log record: {record.getMessage()}"
        )
