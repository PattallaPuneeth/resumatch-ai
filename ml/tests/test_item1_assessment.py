from datetime import date

from ml.scoring.item1_assessment import assess_item1_software_it


def test_assessment_uses_item1_formula_and_withholds_low_confidence_verdict():
    resume = "Experience\nEngineer | Jan 2022 - Jan 2025\nBuilt Python APIs.\n"
    jd = "Required Skills:\n- Python required\n- Java required\n3 years experience required."

    result = assess_item1_software_it(resume, jd, as_of=date(2026, 11, 10))

    assert result["state"] == "SCORED"
    assert result["score"] == 65
    assert result["components"]["sk"] == "0.5"
    assert result["components"]["yr"] == "1"
    assert result["confidence"] == "Low"
    assert result["verdict"] is None
    assert result["verdict_withheld"] is True
    assert result["coverage"]["ratio"] is None


def test_missing_credential_gate_stays_unknown_and_returns_conditional_range():
    result = assess_item1_software_it(
        "Experience\nBuilt Python APIs.",
        "Required Skills:\n- Python required\nAWS certification required.",
        as_of=date(2026, 11, 10),
    )

    assert result["gate_units"][0]["status"] == "Unknown"
    assert result["gate_units"][0]["mandatory"] is True
    assert result["score_range"] is not None
    assert result["verdict"] is None


def test_public_sector_cue_withholds_verdict_and_confirm_only_fields_are_excluded():
    result = assess_item1_software_it(
        "Experience\nBuilt Python APIs.",
        "Public Service Commission Advertisement No. 12\n"
        "Python required. Age relaxation as per Govt. norms. Salary: 12 LPA",
        as_of=date(2026, 11, 10),
    )

    assert result["public_sector_cue"] is not None
    assert result["verdict"] is None
    assert {item["type"] for item in result["confirm_only"]} >= {"salary", "protected_or_public_condition"}
