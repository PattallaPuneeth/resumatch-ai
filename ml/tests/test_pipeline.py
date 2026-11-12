from datetime import date

import pytest
from ml.scoring.pipeline import assess_pair_v30 as assess_pair

AS_OF = date(2026, 11, 11)

# Regression tests for the previous (catalogue) engine, kept as the ITEM12_ENGINE=v30 fallback.
pytestmark = pytest.mark.filterwarnings("ignore")

RESUME = """Asha Rao
Skills
Python, SQL, Docker
Experience
Backend Engineer, Jan 2021 - Dec 2024
- Built REST APIs in Python and PostgreSQL, deployed with Docker.
Education
B.Tech Computer Science
"""
JD = """Backend Engineer
Requirements
- Python
- PostgreSQL
- Kubernetes
Minimum 3 years of experience.
Bachelor's degree required.
"""


def test_end_to_end_software_pair_is_explainable():
    r = assess_pair(RESUME, JD, as_of=AS_OF)
    assert r["state"] == "SCORED" and r["verdict"] in {"Potential Fit", "Good Fit"}
    assert r["score"] == assess_pair(RESUME, JD, as_of=AS_OF)["score"]  # deterministic
    assert any(g["requirement"] == "Kubernetes" for g in r["gaps"])
    assert r["gate_units"][0]["status"] == "Met"
    assert r["component_points"] and r["years"]["required"] == "3"


def test_missing_licence_is_unknown_not_failure():
    jd = "Staff Nurse\nRequired: RN & RM registration with a State Nursing Council.\n3 years of experience required.\n"
    resume = "Priya\nExperience\nStaff Nurse, 2018 - 2024, ICU care.\n"
    r = assess_pair(resume, jd, as_of=AS_OF)
    gate = next(g for g in r["gate_units"] if "Nurse" in g["requirement"])
    assert gate["status"] == "Unknown" and gate["mandatory"]
    assert any("Nurse" in c["requirement"] for c in r["confirm"])
    assert r["verdict_withheld"] is True or r["confidence"] == "Low"


def test_lower_degree_triggers_cap_when_required():
    jd = "Analyst\nRequirements\n- Python\n- SQL\n- Git\nBachelor's degree required.\n"
    resume = "Ravi\nSkills\nPython SQL Git\nExperience\nAnalyst 2020 - 2024 used Python SQL Git\nEducation\nDiploma in Engineering\n"
    r = assess_pair(resume, jd, as_of=AS_OF)
    assert r["gate_units"][0]["status"] == "Not met"
    assert r["score"] is not None and r["score"] <= 69


def test_scrum_master_is_not_a_degree():
    jd = "Lead\nMaster's degree required.\n"
    r = assess_pair("Worked as Scrum Master for 3 years.", jd, as_of=AS_OF)
    assert r["gate_units"][0]["status"] == "Unknown"


def test_empty_jd_abstains_without_crashing():
    r = assess_pair(RESUME, "", as_of=AS_OF)
    assert r["state"] == "ABSTAIN" and r["score"] is None and r["verdict"] is None


def test_public_sector_withholds_band():
    jd = "Advertisement No. 12/2026\nRequirements\n- Python\n- SQL\n- Git\n"
    r = assess_pair(RESUME, jd, as_of=AS_OF)
    assert r["verdict"] is None and r["verdict_withheld"]
