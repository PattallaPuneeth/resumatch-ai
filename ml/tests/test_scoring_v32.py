"""Unit and property test suite for Scoring Architecture v3.2 (docs/SCORING_V32_DESIGN.md)."""

from __future__ import annotations

from datetime import date
from fractions import Fraction as F

import pytest

from ml.scoring import gates as G
from ml.scoring import pipeline_v32 as P32
from ml.scoring import roles as R
from ml.scoring import units as U

TODAY = date(2026, 11, 12)


# ==============================================================================
# 1. Determinism Tests
# ==============================================================================

def test_score_is_bit_identical_across_runs() -> None:
    resume = (
        "ALEX CHEN\n"
        "EXPERIENCE\n"
        "Senior Software Engineer, Acme Corp (Jan 2020 - Present)\n"
        "- Built high-throughput microservices using Go, Kubernetes, and PostgreSQL.\n"
        "- Designed scalable distributed systems handling 50k req/sec.\n"
        "EDUCATION\n"
        "B.Tech in Computer Science, State University (2016 - 2020)\n"
    )
    jd = (
        "Job Title: Senior Backend Engineer\n"
        "Requirements:\n"
        "- 5+ years of experience with Go and Kubernetes\n"
        "- Must have experience designing high-scale distributed systems\n"
        "- PostgreSQL database optimization\n"
    )
    run1 = P32.assess_pair(resume, jd, as_of=TODAY)
    run2 = P32.assess_pair(resume, jd, as_of=TODAY)

    assert run1["score"] == run2["score"]
    assert run1["band"] == run2["band"]
    assert run1["raw_score"] == run2["raw_score"]
    assert run1["coverage"] == run2["coverage"]
    assert run1["seniority"] == run2["seniority"]
    assert run1["versions"] == run2["versions"]


def test_injected_today_controls_all_date_math() -> None:
    resume = "EXPERIENCE\nSoftware Engineer, Acme (Jan 2020 - Present)\n"
    jd = "Job Title: Senior Engineer\n5+ years required\n"
    # When evaluated as of 2022-01-01 (2 years tenure)
    res_2022 = R.assess_seniority(jd, resume, today=date(2022, 1, 1))
    # When evaluated as of 2026-01-01 (6 years tenure)
    res_2026 = R.assess_seniority(jd, resume, today=date(2026, 1, 1))

    assert res_2022.resume.effective_years == pytest.approx(2.0, abs=0.1)
    assert res_2026.resume.effective_years == pytest.approx(6.0, abs=0.1)
    assert res_2022.delta > res_2026.delta


# ==============================================================================
# 2. Seniority & Career Progression Tests (roles.py)
# ==============================================================================

@pytest.mark.parametrize(
    ("delta", "expected_mult", "expected_cap"),
    [
        (-3.0, 1.0, None),
        (0.5, 1.0, None),
        (1.0, 0.89, None),
        (1.99, 0.6722, None),
        (2.0, 0.67, 69),
        (3.0, 0.45, 44),
        (5.0, 0.40, 44),
    ],
)
def test_seniority_multiplier_and_cap_boundaries(delta: float, expected_mult: float, expected_cap: int | None) -> None:
    params = R.SeniorityParams()
    mult, cap = R.seniority_multiplier(delta, params)
    assert mult == pytest.approx(expected_mult, abs=0.01)
    assert cap == expected_cap


def test_overlapping_jobs_not_double_counted() -> None:
    roles = [
        R.Role("Role A", "Acme", date(2020, 1, 1), date(2022, 1, 1), False, R.Span("resume", 0, 6, "Role A")),
        R.Role("Role B", "Beta", date(2021, 1, 1), date(2023, 1, 1), False, R.Span("resume", 0, 6, "Role B")),
    ]
    # Union of [2020-2022] and [2021-2023] is exactly 3 years (2020 to 2023), not 4 years!
    eff = R.effective_years(roles)
    assert eff == pytest.approx(3.0, abs=0.05)


def test_internships_weighted_at_half() -> None:
    roles = [
        R.Role("Software Intern", "Acme", date(2020, 1, 1), date(2021, 1, 1), True, R.Span("resume", 0, 15, "Software Intern")),
    ]
    eff = R.effective_years(roles)
    # 1 year internship counts as 0.5 years
    assert eff == pytest.approx(0.5, abs=0.05)


def test_missing_dates_returns_none_not_zero() -> None:
    roles = [
        R.Role("Engineer", "Acme", None, None, False, R.Span("resume", 0, 8, "Engineer")),
    ]
    assert R.effective_years(roles) is None


def test_junior_vs_principal_on_same_skills_ranks_principal_higher() -> None:
    jd = (
        "Job Title: Principal Backend Architect\n"
        "Requirements:\n"
        "- 8+ years experience\n"
        "- Expert in Go, Kubernetes, and PostgreSQL\n"
        "- Architect high-throughput distributed systems\n"
    )
    # Fresher/Intern: matches Go, Kubernetes, PostgreSQL, but has 2 months internship
    intern_resume = (
        "ALEX INTERN\n"
        "EXPERIENCE\n"
        "Software Engineering Intern, Startup Inc (Jun 2026 - Aug 2026)\n"
        "- Built microservices using Go, Kubernetes, and PostgreSQL.\n"
        "- Maintained distributed systems.\n"
    )
    # Principal: matches Go, Kubernetes, PostgreSQL, and has 10 years experience
    principal_resume = (
        "MORGAN PRINCIPAL\n"
        "EXPERIENCE\n"
        "Principal Architect, Tech Corp (Jan 2016 - Present)\n"
        "- Architected high-throughput microservices using Go, Kubernetes, and PostgreSQL.\n"
        "- Led distributed systems engineering.\n"
    )
    score_intern = P32.assess_pair(intern_resume, jd, as_of=TODAY)
    score_principal = P32.assess_pair(principal_resume, jd, as_of=TODAY)

    assert score_principal["score"] > score_intern["score"]
    assert "SENIORITY_GAP" in score_intern["seniority"]["reason_codes"]


# ==============================================================================
# 3. Context Multipliers & Anti-Keyword Stuffing Tests (units.py)
# ==============================================================================

def test_skills_list_only_evidence_capped() -> None:
    u = U.RequirementUnit("u1", "Python programming", (0, 20), 3.0, False, 3.0)
    # Passages originating exclusively from skills list
    p = [
        U.RerankedPassage("p1", "Python, Docker, SQL", "skills_list", 0.95),
    ]
    ev = U.unit_evidence(u, p)
    assert ev is not None
    # Must be capped at <= 0.35
    assert ev.value <= 0.35


def test_action_experience_bullet_earns_high_credit() -> None:
    u = U.RequirementUnit("u1", "Docker containerization", (0, 25), 3.0, False, 3.0)
    p = [
        U.RerankedPassage(
            "p1",
            "Designed and built Docker containerized microservices reducing latency by 40%",
            "experience",
            0.90,
        ),
    ]
    ev = U.unit_evidence(u, p)
    assert ev is not None
    # High section prior (0.85) + action bonus (0.10) + quantified bonus (0.08) + ownership bonus (0.06)
    assert ev.value > 0.85


def test_generic_mass_never_exceeds_15_percent() -> None:
    # 2 rare units + 3 generic units
    units = [
        U.RequirementUnit("r1", "Apache Spark", (0, 10), 4.0, False, 4.0),
        U.RequirementUnit("r2", "Kubernetes", (10, 20), 4.0, False, 4.0),
        U.RequirementUnit("g1", "Git", (20, 25), 1.0, True, 2.0),
        U.RequirementUnit("g2", "Linux", (25, 30), 1.0, True, 2.0),
        U.RequirementUnit("g3", "Jira", (30, 35), 1.0, True, 2.0),
    ]
    # Total mass = 4 + 4 + 2 + 2 + 2 = 14. Generic = 6 (42.8%!).
    capped = U.apply_generic_cap(units, max_frac=0.15)
    total_w = sum(u.weight for u in capped)
    gen_w = sum(u.weight for u in capped if u.is_generic)
    assert gen_w / total_w <= 0.15001


def test_shrinkage_limits() -> None:
    # When W = 0, coverage shrinks completely to prior
    assert U.shrink(0.9, 0.0, 0.50, k=6.0) == pytest.approx(0.50)
    # When W is very large, shrinkage approaches actual coverage C
    assert U.shrink(0.9, 10000.0, 0.50, k=6.0) == pytest.approx(0.90, abs=0.01)


# ==============================================================================
# 4. Hard Credential Gates Tests (gates.py)
# ==============================================================================

def test_mbbs_missing_caps_at_69_and_reports_reason() -> None:
    jd = (
        "Job Title: Chief Medical Officer\n"
        "Requirements:\n"
        "- Must have MBBS degree from an accredited university\n"
        "- Active Medical Council registration\n"
        "- 10+ years hospital administration experience\n"
    )
    # Candidate is a researcher with PhD in Biology, but NO MBBS
    resume = (
        "DR. SAMANTHA RAY\n"
        "EDUCATION\n"
        "PhD in Molecular Biology, Oxford University\n"
        "B.Sc in Biochemistry, Harvard University\n"
        "EXPERIENCE\n"
        "Clinical Research Director, PharmaCorp (2012 - Present)\n"
        "- Directed clinical trials and medical oncology studies.\n"
    )
    res = P32.assess_pair(resume, jd, as_of=TODAY)
    assert res["score"] <= 69
    assert "gate:mbbs" in res["capped_by"]
    assert any(g["id"] == "mbbs" and g["status"] == "FAIL" for g in res["gates"])


def test_preferred_credential_does_not_cap() -> None:
    jd = (
        "Job Title: Financial Analyst\n"
        "Requirements:\n"
        "- Financial modeling in Excel and SQL\n"
        "- CPA or CFA is preferred / nice to have\n"
    )
    resume = (
        "FINANCIAL ANALYST RESUME\n"
        "EXPERIENCE\n"
        "Financial Analyst, Capital LLC (2022 - Present)\n"
        "- Built financial forecasting models in Excel and SQL.\n"
    )
    res = P32.assess_pair(resume, jd, as_of=TODAY)
    # CPA was preferred, so it must NOT trigger a hard cap
    assert "gate:ca_cpa" not in res["capped_by"]
    assert any(g["id"] == "ca_cpa" and g["status"] == "NOT_MANDATORY" for g in res["gates"])


def test_or_equivalent_experience_downgrades_to_preferred() -> None:
    jd = (
        "Job Title: Software Developer\n"
        "Requirements:\n"
        "- B.Tech in Computer Science or equivalent experience required\n"
        "- Python and Django development\n"
    )
    resume = (
        "EXPERIENCE\n"
        "Self-Taught Developer, Indie Corp (2020 - Present)\n"
        "- Built web applications with Python and Django.\n"
    )
    res = P32.assess_pair(resume, jd, as_of=TODAY)
    assert "gate:btech_be_eng" not in res["capped_by"]


def test_low_confidence_ocr_never_caps() -> None:
    jd = "Requirements:\n- Must have active MBBS degree\n"
    resume = "Doctor with hospital experience"
    # When parse_failed=True, status becomes UNVERIFIABLE and never caps
    res = P32.assess_pair(resume, jd, as_of=TODAY, parse_failed=True)
    assert "gate:mbbs" not in res["capped_by"]
    assert any(g["id"] == "mbbs" and g["status"] == "UNVERIFIABLE" for g in res["gates"])


def test_work_auth_absence_flags_but_never_caps() -> None:
    reg = G.CredentialRegistry.load()
    res = G.evaluate_gates(
        jd_text="Requirements:\n- Must be authorized to work in the United States without sponsorship\n",
        resume_sections="Software Engineer with 5 years Java experience",
        registry=reg,
        parse_ok=True,
    )
    wa_gate = next((g for g in res if g.entry_id == "work_auth"), None)
    assert wa_gate is not None
    assert wa_gate.status == "FAIL"
    assert wa_gate.action == "flag"
    assert wa_gate.cap is None
    # Effective cap must not cap for work auth
    eff = G.effective_cap([wa_gate])
    assert eff is None


# ==============================================================================
# 5. Monotonicity & Zero-Hallucination Span Checks
# ==============================================================================

@pytest.mark.parametrize("cov1,cov2,cap", [
    (0.10, 0.25, 69),
    (0.20, 0.50, 69),
    (0.40, 0.80, 44),
])
def test_capped_curve_preserves_monotonicity(cov1: float, cov2: float, cap: int) -> None:
    curve = P32._curve()
    s1 = round(float(curve(F(str(cov1)))) * 100)
    s2 = round(float(curve(F(str(cov2)))) * 100)
    c1 = min(s1, cap)
    c2 = min(s2, cap)
    assert c1 <= c2


def test_every_evidence_span_is_verbatim() -> None:
    resume = (
        "ALEX CHEN\n"
        "EXPERIENCE\n"
        "Software Engineer, Acme (2020 - Present)\n"
        "- Built containerized services using Kubernetes and Docker.\n"
    )
    jd = "Job Title: DevOps Engineer\nRequirements:\n- Kubernetes cluster management\n"
    res = P32.assess_pair(resume, jd, as_of=TODAY)
    for u in res["units"]:
        if u["evidence"] and u["start"] is not None and u["end"] is not None:
            extracted = resume[u["start"]:u["end"]]
            assert extracted == u["evidence"]
