"""
Regression tests for the matching failures documented in docs/eval/ML_FAILURE_ANALYSIS.md.

Each test pins one bug found in the Phase 10 ML failure analysis so it cannot come back.
"""

from __future__ import annotations

import math

import pytest

from ml.pipelines.embeddings.embedder import embed_query_text, generate_embeddings, get_embedder
from ml.pipelines.intake.entities import extract_skills
from ml.pipelines.matching.reranker import _extract_requirement_excerpt, build_bounded_rerank_query
from ml.pipelines.matching.scorer import blend_final_score, compute_match_scores
from ml.pipelines.matching.skill_gap import (
    analyze_skill_gap,
    extract_skills_from_text,
    resolve_required_skills,
)

REALISTIC_JD = """Job Title: Backend Engineer (Python)
Company: Example Freight

About the Role
We build shipment tracking and rate-quoting APIs for freight brokers and need a backend engineer.

Responsibilities
- Build and maintain Python services using FastAPI that expose shipment, quote and billing data.
- Design and tune schemas in a relational database, writing efficient queries and safe migrations.
- Package services as containers and deploy them to the cloud using container orchestration.
- Improve performance and reliability by profiling endpoints and adding caching where it helps.
- Write automated tests and take part in code review.

Required Skills
- Strong Python, with production experience in FastAPI or a comparable framework such as Flask.
- Working knowledge of a relational database, including SQL, indexing and transactions.
- Experience deploying to a cloud provider, ideally AWS.

Preferred Skills
- Asynchronous Python and message queues.
- Infrastructure as code.
""" + "\n".join(
    f"- Additional responsibility {i}: collaborate with product, support and data teams on delivery."
    for i in range(12)
)


# --- Bug: worker semantic search raised ValueError for any JD over 256 tokens ----------------


def test_embed_query_text_handles_job_descriptions_longer_than_model_window() -> None:
    tokenizer = get_embedder().tokenizer
    assert len(tokenizer.encode(REALISTIC_JD)) > get_embedder().max_seq_length
    with pytest.raises(ValueError):
        generate_embeddings([REALISTIC_JD])  # stored-chunk path stays strict

    vec = embed_query_text(REALISTIC_JD)
    assert len(vec) == 384
    assert math.isclose(math.sqrt(sum(v * v for v in vec)), 1.0, rel_tol=1e-4)


def test_embed_query_text_short_query_is_unchanged() -> None:
    text = "Senior Backend Engineer. Python, PostgreSQL, Kubernetes."
    assert embed_query_text(text) == pytest.approx(generate_embeddings([text])[0], abs=1e-6)


# --- Bug: empty requiredSkills gave every resume 100% coverage (+25 points) -------------------


def test_skill_gap_without_requirements_is_unknown_not_perfect() -> None:
    result = analyze_skill_gap([], ["python"])
    assert result["coverage_ratio"] is None
    assert result["coverageRatio"] is None


def test_unknown_coverage_drops_skill_weight_instead_of_free_points() -> None:
    # Before the fix the same inputs scored 0.65*20 + 25 + 0.10*30 = 41.0
    assert blend_final_score(20.0, None, 0.30) == pytest.approx((0.65 * 20 + 0.10 * 30) / 0.75, abs=0.01)
    scores = compute_match_scores([], [{"score": 0.3}], [{"cross_encoder_logit": -10.0}], {})
    assert scores["skill_coverage"] is None
    assert scores["final_score"] < 20.0


def test_resolve_required_skills_falls_back_to_job_text() -> None:
    assert resolve_required_skills(["Go"], "t", "python") == ["Go"]
    resolved = resolve_required_skills([], "Backend Engineer (Python)", REALISTIC_JD)
    for skill in ("python", "fastapi", "aws", "sql"):
        assert skill in resolved


def test_skill_gap_credits_skills_written_in_resume_text() -> None:
    result = analyze_skill_gap(
        ["account reconciliation", "general ledger"],
        ["Communication"],
        resume_text="Performed monthly bank reconciliations and posted journal entries.",
    )
    assert result["coverage_ratio"] == 1.0


# --- Bug: 16-entry taxonomy had no Java/Kotlin/Spring and no non-tech skills ------------------


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Junior Java Developer with Spring Boot and Hibernate", {"java", "spring", "hibernate"}),
        ("Android app in Kotlin with Jetpack Compose", {"kotlin", "android"}),
        ("Prepared financial statements under GAAP and ran month-end close", {
            "financial reporting", "gaap/ifrs", "month-end close"}),
        ("Lesson planning, classroom management and IEP support", {
            "lesson planning", "classroom management", "special education"}),
        ("Cash handling, KYC checks and loan processing at the branch", {
            "cash handling", "kyc/aml", "loans/credit"}),
    ],
)
def test_taxonomy_covers_core_tech_and_non_tech_skills(text: str, expected: set[str]) -> None:
    assert expected <= set(extract_skills_from_text(text))


@pytest.mark.parametrize(
    "text,not_expected",
    [
        ("Handled the rest of the paperwork.", "rest api"),
        ("Expose shipment, quote and billing data through APIs.", "accounts payable/receivable"),
        ("Keep the page within its performance budget.", "budgeting"),
        ("Follow security best practices in code review.", "application security"),
        ("The controller runs a reconciliation loop.", "account reconciliation"),
    ],
)
def test_taxonomy_ignores_generic_words_in_tech_jds(text: str, not_expected: str) -> None:
    assert not_expected not in extract_skills_from_text(text)


# --- Bug: CE fallback query was built from section headings only ------------------------------


def test_requirement_excerpt_uses_section_bodies_not_headings() -> None:
    excerpt = _extract_requirement_excerpt(REALISTIC_JD)
    assert "Strong Python" in excerpt
    assert excerpt.strip() not in {"Required Skills Preferred Skills", ""}
    assert "Required Skills" not in excerpt


def test_bounded_rerank_query_without_skills_carries_requirements() -> None:
    query = build_bounded_rerank_query("Backend Engineer (Python)", [], REALISTIC_JD)
    # Truncation decodes through the uncased tokenizer, so compare case-insensitively
    assert "fastapi" in query.lower()
    assert "required skills preferred skills" not in query.lower()


# --- Bug: parser read the English word "go" as Go and "R&D" as R ------------------------------


def test_parser_skill_catalog_ignores_common_words() -> None:
    text = "Ready to go the extra mile in R&D projects; took a swift approach to the rest."
    names = {s.name for s in extract_skills(text, {})}
    assert not names & {"Go", "R", "Swift", "REST"}


def test_parser_skill_catalog_still_finds_exact_case_skills() -> None:
    names = {s.name for s in extract_skills("Skills: Go, R, Swift, REST, Python", {})}
    assert {"Go", "R", "Swift", "REST", "Python"} <= names
