"""The real_fit builder: parsing, PII scrubbing, label mapping and leak-free splits."""

from __future__ import annotations

from ml.eval.build_real_fit_dataset import field_of, parse_pairs, scrub, select

LONG_JD = "Senior Python developer to build backend services and APIs. " * 40


def _row(jd: str, resume: str, label: str) -> dict[str, str]:
    return {"text": f"For the given job description <<{jd}>> the resume: <<{resume}>>. The result is, {label}",
            "label": label}


def test_parse_maps_labels_and_skips_unknown() -> None:
    pairs = parse_pairs(
        [_row(LONG_JD, "Python dev", "Good Fit"), _row(LONG_JD, "Cook", "No Fit"),
         _row(LONG_JD, "x", "Maybe")],
        "test",
    )
    assert [p["label"] for p in pairs] == ["strong", "weak"]
    assert pairs[0]["jd_id"] == pairs[1]["jd_id"] and pairs[0]["resume_id"] != pairs[1]["resume_id"]


def test_scrub_removes_contact_details_only() -> None:
    out = scrub("Jane, jane.doe@mail.com, (555) 123-4567, www.jane.dev. Python, 5 years.")
    assert "jane.doe@mail.com" not in out and "123-4567" not in out and "www.jane.dev" not in out
    assert "[email]" in out and "[phone]" in out and "Python, 5 years." in out


def test_select_keeps_long_mixed_label_jobs_and_banned_resumes_out() -> None:
    rows = [_row(LONG_JD, f"resume {i}", lab) for i, lab in
            enumerate(["Good Fit", "Potential Fit", "No Fit", "No Fit", "Good Fit", "Potential Fit"])]
    rows.append(_row("Short JD only.", "resume x", "Good Fit"))
    rows.append(_row("Short JD only.", "resume y", "No Fit"))
    pairs = parse_pairs(rows, "train")
    banned = {next(p["resume_id"] for p in pairs if p["resume"] == "resume 0")}
    chosen = select(pairs, "tune", banned)
    assert {p["jd"] for p in chosen} == {LONG_JD.strip()}  # the short JD is dropped
    assert all(p["resume_id"] not in banned for p in chosen)
    assert len(chosen) == 5 and {p["label"] for p in chosen} == {"strong", "medium", "weak"}


def test_field_of_spreads_jobs() -> None:
    assert field_of("Staff accountant: ledger, audit and tax filings.") == "finance_accounting"
    assert field_of("Registered nurse for patient care in a hospital.") == "healthcare"
