"""Rule tests for v3.1 (tiny strings): alternatives, implied skills, confirm-only and soft lines,
degree wording, and the tips a client sees."""

from datetime import date
from fractions import Fraction as F

from ml.scoring import units as U
from ml.scoring.pipeline import _education_hits, assess_pair

AS_OF = date(2026, 11, 12)


def _credit(jd_line: str, resume: str) -> F:
    seg = U.segment("Requirements:\n- " + jd_line + "\n")
    return U.score_units(seg.units, U.index_resume(resume))[0].credit


def test_alternatives_count_the_best_member_once():
    jd = "Comfortable programming in Python, Scala, or Java."
    only_java = _credit(jd, "Experience\n- Built services in Java")
    nothing = _credit(jd, "Experience\n- Built services in Fortran")
    assert only_java > F(1, 2) and nothing < F(1, 4)  # one alternative is enough
    both = _credit(jd, "Experience\n- Built services in Java and Python")
    assert both == only_java  # more alternatives add nothing


def test_and_or_with_parentheses_is_one_alternative_group():
    seg = U.segment("Requirements:\n- MUST HAVE experience with GCP (Google Cloud Platform) and/or Spark.\n")
    assert seg.units and seg.units[0].or_groups


def test_implied_skill_is_credited_at_ninety_percent_with_a_quote():
    jd = "Requirements:\n- Python development\n"
    seg = U.segment(jd)
    res = U.score_units(seg.units, U.index_resume("Experience\n- Built jobs with PySpark on EMR"))[0]
    hit = next(h for h in res.hits if h.term == "python")
    assert hit.quote == "PySpark" and abs(hit.mult - 0.9) < 1e-9


def test_confirm_only_and_soft_lines_are_never_units():
    jd = (
        "**Pay Rate:** $48/hour (W2)\n**Location:** Atlanta\nRequirements:\n"
        "- Must reside in Atlanta, GA.\n- Excellent oral and written communication skills.\n"
        "- Python and SQL services\n"
    )
    seg = U.segment(jd)
    texts = " ".join(u.text for u in seg.units)
    assert "Atlanta" not in texts and "communication" not in texts and "Python" in texts
    assert seg.soft_skills == ("Excellent oral and written communication skills.",)


def test_boilerplate_at_the_end_of_a_run_on_line_keeps_the_requirements():
    jd = ("Need candidates with 3+ years of real experience with Azure Databricks and Spark pipelines "
          "plus strong SQL tuning skills and Kafka streaming experience in production use "
          "Need to go through background check")
    assert U.segment(jd).units


def test_bachelors_and_masters_wording_is_recognised_as_degree_lines():
    assert _education_hits("Bachelors degree in accounting") == [3, 3]
    assert _education_hits("Masters degree preferred")[0] == 4
    assert _education_hits("Scrum Master for 3 years") == []


def test_degree_lines_are_gates_not_skill_units():
    jd = "Job Title: Accountant\nRequirements:\n- Bachelors degree required\n- General ledger and reconciliations\n"
    r = assess_pair("Experience\nAccountant 2018-2024 general ledger reconciliations", jd, as_of=AS_OF)
    assert not any("Bachelors" in u["skill"] for u in r["skill_units"])
    assert r["gate_units"] and r["gate_units"][0]["requirement"] == "Education requirement"


def test_tips_name_what_is_missing_and_never_blame():
    jd = "Job Title: Accountant\nRequirements:\n- Experience with SAP and QuickBooks required\n"
    r = assess_pair("Experience\nAccountant 2018-2024 handled invoices", jd, as_of=AS_OF)
    tips = [g["tip"] for g in r["gaps"] if g["kind"] == "skill"]
    assert tips and any("sap" in t.lower() for t in tips)
    assert all("lack" not in t.lower() and "fail" not in t.lower() for t in tips)
    assert not any(t.startswith('The job asks for: "Accountant"') for t in tips)  # title line


def test_list_only_evidence_gets_a_show_it_in_a_bullet_tip():
    jd = "Job Title: Engineer\nRequirements:\n- Kubernetes\n"
    r = assess_pair("Skills\nKubernetes", jd, as_of=AS_OF)
    assert any("skills list" in g["tip"] for g in r["gaps"]) or r["skill_units"][0]["credit"] >= 0.7


def test_role_fit_and_soft_skills_are_in_the_payload():
    jd = "Job Title: Staff Accountant\nRequirements:\n- General ledger\n- Strong communication skills\n"
    r = assess_pair("Experience\nElectrician, 2015 - 2024, Acme Electric", jd, as_of=AS_OF)
    assert r["role_fit"]["relation"] == "different field"
    assert r["soft_skills_not_scored"]
    assert any(g["kind"] == "role" for g in r["gaps"])
