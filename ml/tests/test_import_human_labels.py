"""Validation rules for importing the hand-labeled hard pairs."""

from __future__ import annotations

import pytest

from ml.eval.import_human_labels import LabelImportError, validate


def _row(pid: str, label: str, notes: str = "ok") -> dict[str, str]:
    return {"pair_id": pid, "human_label": label, "notes": notes, "auto_label": "strong"}


def test_valid_rows_are_kept_and_normalised() -> None:
    rows = validate([_row("kaggle_domain:test:R1.txt:job_a.txt", " Strong ")])
    assert rows[0]["human_label"] == "strong"


def test_skip_rows_are_dropped() -> None:
    rows = validate(
        [
            _row("kaggle_domain:test:R1.txt:job_a.txt", "weak"),
            _row("extended:-:r.txt:j.txt", "", notes="skip - broken text"),
        ]
    )
    assert [r["pair_id"] for r in rows] == ["kaggle_domain:test:R1.txt:job_a.txt"]


@pytest.mark.parametrize(
    "rows",
    [
        [_row("kaggle_domain:test:R1.txt:job_a.txt", "")],
        [_row("kaggle_domain:test:R1.txt:job_a.txt", "excellent")],
        [_row("unknown:test:R1.txt:job_a.txt", "weak")],
        [_row("kaggle_domain:test:R1.txt:job_a.txt", "weak")] * 2,
    ],
)
def test_invalid_rows_are_rejected(rows: list[dict[str, str]]) -> None:
    with pytest.raises(LabelImportError):
        validate(rows)
