"""
Dataset loading and validation for ResuMatch AI Evaluation Harness (Phase 3C-1).

Validates:
- Presence of labels.csv with columns: resume, job, expected, reason
- Valid expected labels: 'strong', 'medium', 'weak'
- Uniqueness of (resume, job) pairs
- File existence for all resumes and job descriptions
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

VALID_LABELS = {"strong", "medium", "weak"}
REQUIRED_COLUMNS = {"resume", "job", "expected", "reason"}


@dataclass(frozen=True)
class EvaluationExample:
    resume_name: str
    job_name: str
    expected: str
    reason: str
    resume_path: Path
    job_path: Path


class DatasetValidationError(ValueError):
    """Raised when evaluation dataset structure, files, or labels are invalid."""


def load_and_validate_dataset(dataset_dir: str | Path) -> list[EvaluationExample]:
    """
    Loads and rigorously validates an evaluation dataset directory.

    Expected structure:
        <dataset_dir>/
            resumes/
                <resume_file>.pdf or .docx
            jobs/
                <job_file>.txt
            labels.csv

    Args:
        dataset_dir: Path to directory containing resumes/, jobs/, and labels.csv.

    Returns:
        List of validated EvaluationExample instances.

    Raises:
        DatasetValidationError: On missing files, missing columns,
            duplicate pairs, or invalid labels.
        FileNotFoundError: If the dataset directory or labels.csv does not exist.
    """
    root = Path(dataset_dir)
    if not root.exists() or not root.is_dir():
        raise FileNotFoundError(f"Dataset directory not found: {root}")

    resumes_dir = root / "resumes"
    jobs_dir = root / "jobs"
    labels_file = root / "labels.csv"

    if not resumes_dir.exists() or not resumes_dir.is_dir():
        raise DatasetValidationError(f"Missing required 'resumes' directory at {resumes_dir}")

    if not jobs_dir.exists() or not jobs_dir.is_dir():
        raise DatasetValidationError(f"Missing required 'jobs' directory at {jobs_dir}")

    if not labels_file.exists():
        raise FileNotFoundError(f"Missing required 'labels.csv' at {labels_file}")

    examples: list[EvaluationExample] = []
    seen_pairs: set[tuple[str, str]] = set()

    with open(labels_file, encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            raise DatasetValidationError(f"labels.csv at {labels_file} is empty or unreadable")

        fieldnames_clean = {c.strip() for c in reader.fieldnames if c}
        missing_cols = REQUIRED_COLUMNS - fieldnames_clean
        if missing_cols:
            raise DatasetValidationError(
                f"labels.csv missing required column(s): {sorted(missing_cols)}. "
                f"Found columns: {sorted(fieldnames_clean)}"
            )

        for row_idx, raw_row in enumerate(reader, start=2):
            row = {k.strip(): (v.strip() if v else "") for k, v in raw_row.items() if k}

            resume_name = row.get("resume", "")
            job_name = row.get("job", "")
            expected = row.get("expected", "").lower()
            reason = row.get("reason", "")

            if not resume_name:
                raise DatasetValidationError(f"Row {row_idx}: 'resume' column cannot be empty")
            if not job_name:
                raise DatasetValidationError(f"Row {row_idx}: 'job' column cannot be empty")

            pair_key = (resume_name, job_name)
            if pair_key in seen_pairs:
                raise DatasetValidationError(
                    f"Row {row_idx}: Duplicate pair detected for ({resume_name}, {job_name})"
                )
            seen_pairs.add(pair_key)

            if expected not in VALID_LABELS:
                raise DatasetValidationError(
                    f"Row {row_idx}: Invalid label '{expected}' for "
                    f"pair ({resume_name}, {job_name}). "
                    f"Must be one of: {sorted(VALID_LABELS)}"
                )

            resume_path = resumes_dir / resume_name
            if not resume_path.exists():
                raise DatasetValidationError(
                    f"Row {row_idx}: Referenced resume file not found on disk: {resume_path}"
                )

            job_path = jobs_dir / job_name
            if not job_path.exists():
                raise DatasetValidationError(
                    f"Row {row_idx}: Referenced job file not found on disk: {job_path}"
                )

            examples.append(
                EvaluationExample(
                    resume_name=resume_name,
                    job_name=job_name,
                    expected=expected,
                    reason=reason,
                    resume_path=resume_path,
                    job_path=job_path,
                )
            )

    if not examples:
        raise DatasetValidationError(
            f"labels.csv at {labels_file} contains no valid evaluation rows"
        )

    return examples
