"""
Unit tests for Step 5: Grounded Fact Guardrail & Mutation Test Suite.
Verifies numerical conservation, per-unit tolerance derivations,
seniority inflation, verb ladder scope jumps, and [X] neutralization fallback.
"""

from __future__ import annotations

import pytest
from ml.scoring.guardrails import (
    ResumeSuggestionValidator,
    Severity,
    ValidationResult,
    Verdict,
    parse_numeric_claims,
)


class TestNumericClaimParser:
    def test_parse_numeric_claims(self) -> None:
        text = "Reduced latency by 45% ($2M savings) from 800ms to 200ms across 5k servers."
        claims = parse_numeric_claims(text)
        units = {c.unit: c.value for c in claims}

        assert units["%"] == 45.0
        assert units["$"] == 2_000_000.0
        assert units["time"] in (800.0, 200.0)
        assert units["count"] == 5_000.0

    def test_ignores_calendar_years(self) -> None:
        text = "Graduated in 2021 and joined team in 2022."
        claims = parse_numeric_claims(text)
        assert len(claims) == 0


class TestFactGroundingValidator:
    @pytest.fixture
    def validator(self) -> ResumeSuggestionValidator:
        return ResumeSuggestionValidator(
            known_candidate_skills=["python", "fastapi", "postgresql", "docker"],
            candidate_seniority_history=["software engineer", "developer"],
        )

    def test_exact_metric_match_accepted(self, validator: ResumeSuggestionValidator) -> None:
        orig = "Reduced API response times by 35% using Redis caching."
        sugg = "Optimized API response times by 35% through Redis caching layer."
        res = validator.validate_rewrite(orig, sugg)
        assert res.accepted is True
        assert res.verdict in (Verdict.ACCEPT, Verdict.WARN)
        assert not any(v.kind == "NEW_METRIC" for v in res.violations)

    def test_derivable_percentage_accepted(self, validator: ResumeSuggestionValidator) -> None:
        # Original has 800ms and 200ms -> Delta = 600/800 = 75%
        orig = "Decreased query latency from 800ms down to 200ms."
        sugg = "Optimized database query latency by 75% via composite indices."
        res = validator.validate_rewrite(orig, sugg)
        # 75% is derived mathematically from 800ms and 200ms (within 1.5pp tolerance)
        assert not any(v.kind == "NEW_METRIC" for v in res.violations)

    def test_hallucinated_percentage_rejected_and_neutralized(
        self, validator: ResumeSuggestionValidator
    ) -> None:
        orig = "Implemented Redis caching for user profile endpoints."
        sugg = "Implemented Redis caching for user profile endpoints, boosting throughput by 42%."
        res = validator.validate_rewrite(orig, sugg)

        assert res.accepted is False
        assert res.verdict == Verdict.REJECT
        assert any(v.kind == "NEW_METRIC" for v in res.violations)
        # Neutralization fallback must substitute fabricated 42% with [X]%
        assert res.neutralized_bullet is not None
        assert "[X]%" in res.neutralized_bullet

    def test_implied_metric_rejected(self, validator: ResumeSuggestionValidator) -> None:
        orig = "Managed customer onboarding process."
        sugg = "Streamlined onboarding process, resulting in doubled customer retention."
        res = validator.validate_rewrite(orig, sugg)

        assert res.accepted is False
        assert any(v.kind == "IMPLIED_METRIC" for v in res.violations)

    def test_seniority_title_inflation_rejected(
        self, validator: ResumeSuggestionValidator
    ) -> None:
        orig = "Collaborated on billing pipeline architecture."
        sugg = "Acted as Principal Architect designing billing pipeline architecture."
        res = validator.validate_rewrite(orig, sugg)

        assert res.accepted is False
        assert any(v.kind == "TITLE_INFLATION" for v in res.violations)

    def test_verb_ownership_ladder_scope_inflation(
        self, validator: ResumeSuggestionValidator
    ) -> None:
        # "Assisted" (Level 1) -> "Architected" (Level 3): jump >= 2 is CRITICAL scope inflation
        orig = "Assisted with Kubernetes deployment automation."
        sugg = "Architected Kubernetes deployment automation."
        res = validator.validate_rewrite(orig, sugg)

        assert res.accepted is False
        assert res.verdict == Verdict.REJECT
        assert any(v.kind == "SCOPE_INFLATION" for v in res.violations)

    def test_tool_containment_flags_unearned_tools(
        self, validator: ResumeSuggestionValidator
    ) -> None:
        orig = "Wrote automated tests for microservices."
        # Snowflake is not in candidate skills and not in original text
        sugg = "Wrote automated tests for Snowflake microservices."
        res = validator.validate_rewrite(orig, sugg)

        assert any(v.kind == "UNKNOWN_ENTITY" and "Snowflake" in v.token for v in res.violations)


class TestMutationCorpusBenchmark:
    """
    Evaluates the guardrail against a labeled synthetic mutation set to ensure
    recall >= 95% on critical categories (hallucinated metrics, ungrounded tools, title inflation).
    """

    def test_critical_category_recall_exceeds_95_percent(self) -> None:
        validator = ResumeSuggestionValidator(
            known_candidate_skills=["python", "django", "postgresql"],
            candidate_seniority_history=["software engineer"],
        )

        base_bullet = "Assisted with backend services using Python and PostgreSQL."
        
        # 20 synthetic mutations testing various hallucination vectors
        mutations = [
            # Injected percentages
            ("Developed backend services using Python, increasing speed by 25%.", "NEW_METRIC"),
            ("Developed backend services using Python, saving $50k annually.", "NEW_METRIC"),
            ("Developed backend services using Python serving 10M users.", "NEW_METRIC"),
            ("Developed backend services using Python with 99.9% uptime.", "NEW_METRIC"),
            ("Developed backend services using Python achieving 4x throughput.", "NEW_METRIC"),
            # Injected implied metrics
            ("Developed backend services using Python, which doubled efficiency.", "IMPLIED_METRIC"),
            ("Developed backend services using Python, achieving tenfold speedup.", "IMPLIED_METRIC"),
            ("Developed backend services using Python handling millions of calls.", "IMPLIED_METRIC"),
            # Injected seniority
            ("Led as Staff Engineer developing backend services using Python.", "TITLE_INFLATION"),
            ("Served as Chief Architect on backend services using Python.", "TITLE_INFLATION"),
            ("Acted as Vice President overseeing Python services.", "TITLE_INFLATION"),
            ("Head of Engineering developing backend services using Python.", "TITLE_INFLATION"),
            # Injected tools
            ("Developed backend services using Python and Kubernetes.", "UNKNOWN_ENTITY"),
            ("Developed backend services using Python and Terraform.", "UNKNOWN_ENTITY"),
            ("Developed backend services using Python and Datadog.", "UNKNOWN_ENTITY"),
            ("Developed backend services using Python and RabbitMQ.", "UNKNOWN_ENTITY"),
            ("Developed backend services using Python and Snowflake.", "UNKNOWN_ENTITY"),
            # Scope inflation
            ("Architected backend services using Python and PostgreSQL.", "SCOPE_INFLATION"),
            ("Spearheaded backend services using Python and PostgreSQL.", "SCOPE_INFLATION"),
            ("Founded backend services using Python and PostgreSQL.", "SCOPE_INFLATION"),
        ]

        detected = 0
        for mutated_bullet, expected_violation in mutations:
            res = validator.validate_rewrite(base_bullet, mutated_bullet)
            violation_kinds = [v.kind for v in res.violations]
            if expected_violation in violation_kinds:
                detected += 1

        recall = detected / len(mutations)
        assert recall >= 0.95, f"Recall was {recall:.1%}, target is >= 95%"
