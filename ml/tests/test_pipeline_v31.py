"""Behavior tests for the v3.1 pipeline (tiny strings; these check rules, not accuracy)."""

import csv
import os
from datetime import date

import pytest

from ml.scoring.pipeline import assess_pair
from ml.scoring.pipeline_v31 import unsupported_fraction

AS_OF = date(2026, 11, 12)
JD = (
    "Backend Engineer\n"
    "Requirements:\n"
    "- Build REST services in Python and PostgreSQL\n"
    "- Deploy containers with Docker and Kubernetes\n"
    "- 3+ years of experience\n"
    "- Bachelor's degree required\n"
)
RESUME = (
    "Experience\n"
    "Backend Engineer, 01/2019 - 12/2024\n"
    "- Built REST services in Python with PostgreSQL and deployed containers with Docker\n"
    "Education\n"
    "B.Tech Computer Science\n"
)


def test_default_engine_is_v31_and_payload_is_explainable():
    r = assess_pair(RESUME, JD, as_of=AS_OF)
    assert r["version"] == "unified-3.1" and r["engine"]["extraction"] == "deterministic"
    assert r["state"] == "SCORED" and r["tier"] in {"Firm", "Tentative"}
    assert r["score"] is not None and r["verdict"] in {"No Fit", "Potential Fit", "Good Fit"}
    unit = next(u for u in r["skill_units"] if "REST services" in u["skill"])
    assert unit["credit"] > 0.5 and unit["evidence"] and unit["matched_terms"]
    assert RESUME[unit["start"] : unit["end"]] == unit["evidence"]  # verbatim span
    assert any("Kubernetes" in g["requirement"] for g in r["gaps"])
    assert r["gate_units"][0]["status"] == "Met"


def test_deterministic_and_unfitted_curve_forces_tentative():
    a, b = assess_pair(RESUME, JD, as_of=AS_OF), assess_pair(RESUME, JD, as_of=AS_OF)
    assert a == b
    assert a["engine"]["curve_fitted"] is False and a["tier"] == "Tentative"
    assert any("not calibrated" in x for x in a["confidence_reasons"])


def test_v30_fallback_switch(monkeypatch):
    monkeypatch.setenv("ITEM12_ENGINE", "v30")
    assert assess_pair(RESUME, JD, as_of=AS_OF)["version"] == "unified-1.0"


def test_missing_licence_is_unknown_and_listed_to_confirm():
    jd = "Staff Nurse\nRequirements:\n- Required: RN & RM registration with a State Nursing Council\n- ICU patient care\n"
    r = assess_pair("Experience\nStaff Nurse 2018 - 2024 ICU patient care", jd, as_of=AS_OF)
    gate = next(g for g in r["gate_units"] if "Nurse" in g["requirement"])
    assert gate["status"] == "Unknown" and gate["mandatory"]
    assert any("Nurse" in c["requirement"] for c in r["confirm"])
    assert r["verdict"] is not None  # a missing licence never hides the verdict


def test_lower_degree_when_required_caps_at_69():
    resume = RESUME.replace("B.Tech Computer Science", "Diploma in Engineering")
    r = assess_pair(resume, JD, as_of=AS_OF)
    assert r["gate_units"][0]["status"] == "Not met"
    assert r["score"] <= 69


def test_abstains_only_for_hard_reasons():
    assert assess_pair(RESUME, "", as_of=AS_OF)["tier"] == "Abstain"
    assert assess_pair(RESUME, JD, as_of=AS_OF, parse_failed=True)["tier"] == "Abstain"
    r = assess_pair("你好" * 300, "要求" * 300, as_of=AS_OF)
    assert r["tier"] == "Abstain" and r["verdict"] is None and "language" in r["withheld_reason"]


def test_public_sector_notice_shows_score_but_no_band():
    jd = "Advertisement No. 12/2026\nRequirements:\n- Python and PostgreSQL services\n- Docker deployment\n"
    r = assess_pair(RESUME, jd, as_of=AS_OF)
    assert r["tier"] == "Comparison only" and r["verdict"] is None and r["score"] is not None


def test_hidden_characters_are_removed_and_reported():
    r = assess_pair("Py​thon engineer\n" + RESUME, JD, as_of=AS_OF)
    assert any("Invisible characters" in x for x in r["limitations"])


def test_unsupported_fraction():
    assert unsupported_fraction("plain english text") == 0.0
    assert unsupported_fraction("你好") == 1.0
    assert unsupported_fraction("") == 0.0


def test_scores_do_not_depend_on_the_clock():
    a = assess_pair(RESUME, JD, as_of=date(2026, 11, 12))
    b = assess_pair(RESUME, JD, as_of=date(2026, 11, 12))
    assert a["score"] == b["score"]
    os.environ.pop("ITEM12_ENGINE", None)


def test_fit_curve_command_refuses_small_sets(tmp_path):
    from ml.evalkit import item12_eval as H

    path = tmp_path / "small.csv"
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["resume_text", "job_description_text", "label", "split"])
        w.writeheader()
        for i in range(10):
            w.writerow({"resume_text": f"r{i}", "job_description_text": f"Requirements:\n- thing number {i} tool",
                        "label": "No Fit", "split": "tune"})
    with pytest.raises(SystemExit):
        H.main(["fit-curve", "--input", str(path)])
