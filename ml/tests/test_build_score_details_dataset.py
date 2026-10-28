"""The score_details builder: GPT-4o score bands, titles, scrubbing and the JD split."""

from __future__ import annotations

from ml.eval.build_score_details_dataset import (
    clean_title,
    gpt_label,
    redact_personal,
    scrub_strict,
    split_by_jd,
)


def test_gpt_label_needs_all_requirements_for_strong() -> None:
    assert gpt_label(8.0, 2, 2) == "strong"
    assert gpt_label(8.0, 1, 2) == "medium"
    assert gpt_label(3.5, 2, 2) == "weak"
    assert gpt_label(6.0, 0, 3) == "weak"


def test_clean_title_keeps_only_the_role() -> None:
    assert clean_title("Join **TechVentures Inc.** as a **Senior Project Manager**") == (
        "Senior Project Manager")
    assert clean_title("Job Title: Job Title: Lead Engineer at TechInnovate Solutions") == (
        "Lead Engineer")
    assert clean_title("**Business Development Manager**") == "Business Development Manager"


def test_scrub_strict_catches_spaced_out_contacts() -> None:
    # Over-scrubbing an "Executive @ Company" line is accepted; leaking a contact is not
    out = scrub_strict("Ali Khan | sam.lee. 42@example. com | +92 3001234567 | Lahore")
    assert "example" not in out and "3001234567" not in out
    assert out.startswith("Ali Khan") and out.endswith("Lahore")


def test_split_by_jd_keeps_each_jd_in_one_split() -> None:
    pairs = [{"jd_id": f"j{i % 5}", "resume_id": f"r{i}"} for i in range(40)]
    out = split_by_jd(pairs)
    splits: dict[str, set[str]] = {}
    for p in out:
        splits.setdefault(p["jd_id"], set()).add(p["split"])
    assert all(len(s) == 1 for s in splits.values())
    assert {"test", "tune"} == {s for v in splits.values() for s in v}


def test_redact_personal_removes_name_and_personal_fields() -> None:
    text = ("S a r a M a l i k | Sales Lead\nDate of Birth: 14-Mar-1990 Gender :Male\n"
            "Marital Status: Married | Religion: Islam\nMalik led a team of 5 at Acme.")
    out = redact_personal(text, ["Sara Malik"])
    for leaked in ("S a r a", "Malik", "1990", "Male", "Married", "Islam"):
        assert leaked not in out
    assert "Sales Lead" in out and "led a team of 5 at Acme." in out


def test_redact_personal_keeps_ordinary_words() -> None:
    text = "Sold passport scanners; studied the gender gap in sales"
    assert redact_personal(text, []) == text


def test_redact_personal_handles_run_together_text() -> None:
    out = redact_personal("SARAMALIK PROJECT LEAD | Religion. :Islam", ["Sara Malik"])
    assert "SARA" not in out and "MALIK" not in out and "Islam" not in out
    assert "PROJECT LEAD" in out
