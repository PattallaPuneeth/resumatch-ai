"""
Tests for Skill Taxonomy & Word-Boundary Skill Matching (Phase 3C-1).

Verifies canonical alias mapping, group synonyms, and strict false-positive prevention:
- 'Java' must not match 'JavaScript'
- 'C' must not match 'C++', 'C#', or 'CSS'
- 'Go' must not match 'Google Cloud' or 'Django'
"""

import pytest

from ml.pipelines.matching.skill_gap import (
    _normalize_skill,
    analyze_skill_gap,
    load_skill_aliases,
)


def test_taxonomy_file_loads() -> None:
    aliases = load_skill_aliases(force_reload=True)
    assert isinstance(aliases, dict)
    assert len(aliases) >= 15
    assert aliases["k8s"] == "kubernetes"
    assert aliases["postgres"] == "postgresql"
    assert aliases["js"] == "javascript"
    assert aliases["ts"] == "typescript"
    assert aliases["ml"] == "machine learning"


@pytest.mark.parametrize(
    "synonym,canonical",
    [
        ("k8s", "kubernetes"),
        ("kubernetes", "kubernetes"),
        ("container orchestration", "kubernetes"),
        ("postgres", "postgresql"),
        ("postgresql", "postgresql"),
        ("pgsql", "postgresql"),
        ("relational database", "postgresql"),
        ("js", "javascript"),
        ("javascript", "javascript"),
        ("ts", "typescript"),
        ("typescript", "typescript"),
        ("node", "nodejs"),
        ("node.js", "nodejs"),
        ("nodejs", "nodejs"),
        ("py", "python"),
        ("python", "python"),
        ("ml", "machine learning"),
        ("machine learning", "machine learning"),
        ("ai/ml", "machine learning"),
        ("ci/cd", "ci/cd"),
        ("cicd", "ci/cd"),
        ("continuous integration", "ci/cd"),
        ("continuous deployment", "ci/cd"),
        ("github actions", "ci/cd"),
        ("gitlab ci", "ci/cd"),
        ("docker", "docker"),
        ("containerization", "docker"),
        ("react", "react"),
        ("react.js", "react"),
        ("reactjs", "react"),
        ("aws", "aws"),
        ("amazon web services", "aws"),
        ("gcp", "gcp"),
        ("google cloud", "gcp"),
        ("google cloud platform", "gcp"),
    ],
)
def test_skill_taxonomy_groups(synonym: str, canonical: str) -> None:
    assert _normalize_skill(synonym) == canonical


def test_synonym_matching_in_gap_analysis() -> None:
    # Job requires canonical and resume provides acronym
    job_reqs = ["Kubernetes", "PostgreSQL", "TypeScript", "CI/CD"]
    resume_skills = ["K8s", "Postgres", "TS", "GitHub Actions"]

    res = analyze_skill_gap(job_reqs, resume_skills)
    assert res["coverage_ratio"] == 1.0
    assert len(res["matched"]) == 4
    assert len(res["missing"]) == 0
    assert len(res["partial"]) == 0


def test_false_positive_rejection_java_vs_javascript() -> None:
    # Java requirement vs JavaScript resume skill
    job_reqs = ["Java"]
    resume_skills = ["JavaScript", "HTML", "CSS"]

    res = analyze_skill_gap(job_reqs, resume_skills)
    assert "Java" in res["missing"]
    assert "Java" not in res["matched"]
    assert "Java" not in res["partial"]
    assert res["coverage_ratio"] == 0.0


def test_false_positive_rejection_c_vs_cpp_csharp() -> None:
    # C requirement vs C++ and C#
    job_reqs = ["C"]
    resume_skills = ["C++", "C#", "CSS"]

    res = analyze_skill_gap(job_reqs, resume_skills)
    assert "C" in res["missing"]
    assert "C" not in res["matched"]
    assert "C" not in res["partial"]
    assert res["coverage_ratio"] == 0.0


def test_false_positive_rejection_go_vs_django() -> None:
    # Go requirement vs Django or Google Cloud
    job_reqs = ["Go"]
    resume_skills = ["Django", "Algorithm"]

    res = analyze_skill_gap(job_reqs, resume_skills)
    assert "Go" in res["missing"]
    assert "Go" not in res["matched"]
    assert res["coverage_ratio"] == 0.0


def test_partial_match_word_boundary() -> None:
    # Multi-word skill with boundary match
    job_reqs = ["Relational Database"]
    resume_skills = ["Relational Database Design", "Python"]

    res = analyze_skill_gap(job_reqs, resume_skills)
    assert "Relational Database" in res["matched"] or "Relational Database" in res["partial"]
    assert res["coverage_ratio"] >= 0.5
