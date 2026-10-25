"""
Unit tests for Fact-Grounded Bullet Rewriter Verifier (Phase 4B).
Validates that:
- Invented numbers/percentages are rejected
- Invented tools are rejected
- Numbers present in original bullet are accepted
- Placeholders are accepted and set needsUserInput=True
- Aliases (K8s/Kubernetes, Postgres/PostgreSQL) are accepted
- Credentials without grounding are rejected
"""

from __future__ import annotations

import pytest

from ml.pipelines.rewriter.models import LLMRewriterOption
from ml.pipelines.rewriter.verifier import BulletRewriteVerifier


@pytest.fixture
def verifier() -> BulletRewriteVerifier:
    return BulletRewriteVerifier()


def test_verifier_invented_number_rejected(verifier: BulletRewriteVerifier) -> None:
    """Verifies that invented numbers/percentages not in source text are rejected."""
    original_bullet = "Refactored payment processing service to improve latency."
    raw_text = f"Experience:\n- {original_bullet}\nSkills: Python, FastAPI."

    # Rewrite invents '45%' metric
    option = LLMRewriterOption(
        text="Refactored Python payment microservice, improving latency by 45%.",
        evidence_quotes=["Refactored payment processing service to improve latency."],
        needs_user_input=False,
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert not res.is_valid
    assert "Invented metric" in (res.rejection_reason or "")
    assert res.option is None


def test_verifier_original_bullet_number_accepted(verifier: BulletRewriteVerifier) -> None:
    """Verifies that numbers present in original bullet or rawText are accepted."""
    original_bullet = "Reduced API response times by 35% across 4 core microservices."
    raw_text = f"Work Experience:\n{original_bullet}\nTechnologies: Python, Redis."

    option = LLMRewriterOption(
        text=(
            "Engineered caching architecture using Redis, "
            "reducing API response times by 35% across 4 core microservices."
        ),
        evidence_quotes=["Reduced API response times by 35% across 4 core microservices."],
        needs_user_input=False,
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert res.is_valid
    assert res.option is not None
    assert res.option.text == option.text
    assert not res.option.needs_user_input
    assert len(res.option.evidence_spans) > 0


def test_verifier_invented_tool_rejected(verifier: BulletRewriteVerifier) -> None:
    """Verifies that tools not in candidate rawText or original bullet are rejected."""
    original_bullet = "Containerized services and streamlined CI/CD pipelines."
    raw_text = f"Experience:\n{original_bullet}\nSkills: Docker, GitHub Actions."

    # Candidate has Docker, but NOT Kubernetes. Rewrite claims Kubernetes:
    option = LLMRewriterOption(
        text=(
            "Orchestrated container deployments on Kubernetes clusters, "
            "streamlining deployment workflows."
        ),
        evidence_quotes=["Containerized services and streamlined CI/CD pipelines."],
        needs_user_input=False,
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert not res.is_valid
    assert "not present in candidate resume" in (res.rejection_reason or "")


def test_verifier_alias_accepted(verifier: BulletRewriteVerifier) -> None:
    """Verifies that canonical tool name is accepted when alias exists in rawText."""
    original_bullet = "Maintained high availability database and cluster nodes."
    raw_text = (
        "Experience:\n"
        "- Maintained high availability database and cluster nodes.\n"
        "Skills: k8s, postgres, docker, python."
    )

    # Rewrite uses canonical 'Kubernetes' and 'PostgreSQL' while rawText has 'k8s' and 'postgres'
    option = LLMRewriterOption(
        text=(
            "Maintained high-availability PostgreSQL databases "
            "and Kubernetes cluster nodes with zero downtime."
        ),
        evidence_quotes=["Maintained high availability database and cluster nodes."],
        needs_user_input=False,
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert res.is_valid, f"Expected alias match to pass, got: {res.rejection_reason}"
    assert res.option is not None


def test_verifier_placeholder_accepted(verifier: BulletRewriteVerifier) -> None:
    """Verifies that placeholders like [add metric] are accepted and set needsUserInput=True."""
    original_bullet = "Automated data ingestion pipelines for the analytics team."
    raw_text = f"Experience:\n- {original_bullet}\nSkills: Python, SQL."

    option = LLMRewriterOption(
        text=(
            "Architected automated Python data ingestion pipelines, "
            "reducing processing turnaround by [add metric]."
        ),
        evidence_quotes=["Automated data ingestion pipelines for the analytics team."],
        needs_user_input=False,  # verifier should automatically set this to True
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert res.is_valid
    assert res.option is not None
    assert res.option.needs_user_input is True


def test_verifier_unsupported_credential_rejected(verifier: BulletRewriteVerifier) -> None:
    """Verifies that credentials/degrees not present in candidate resume are rejected."""
    original_bullet = "Led agile sprint planning sessions and cross-functional teams."
    raw_text = f"Experience:\n- {original_bullet}\nSkills: Agile, JIRA."

    option = LLMRewriterOption(
        text=(
            "Directed agile sprint planning as certified PMP and Scrum Master, "
            "improving team velocity."
        ),
        evidence_quotes=["Led agile sprint planning sessions and cross-functional teams."],
        needs_user_input=False,
    )

    res = verifier.verify_option(option, original_bullet, raw_text)
    assert not res.is_valid
    assert "Credential" in (res.rejection_reason or "")


def test_verifier_all_failing_drops_options(verifier: BulletRewriteVerifier) -> None:
    """Verifies that verify_all drops all failing options and returns empty list."""
    original_bullet = "Wrote automated tests."
    raw_text = f"Experience:\n- {original_bullet}\nSkills: Python."

    options = [
        LLMRewriterOption(text="Achieved 99.9% test coverage.", evidence_quotes=[]),
        LLMRewriterOption(text="Managed AWS deployments.", evidence_quotes=[]),
        LLMRewriterOption(text="Earned CISSP certification.", evidence_quotes=[]),
    ]

    verified = verifier.verify_all(options, original_bullet, raw_text)
    assert len(verified) == 0
