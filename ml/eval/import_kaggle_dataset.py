"""
Converts the resume-job matching CSV (ml/eval/datasets/kaggle_domain/source/) into the
eval harness layout: resumes/<resume_id>.txt, jobs/job_<title>.txt and labels.csv.

- match_label 1 -> 'strong', 0 -> 'weak'. Rows with an empty label
  (review_status = needs_manual_review) are skipped, never guessed.
- 'split' is assigned per resume_id (sha256 mod 10 < 4 -> 'test', else 'tune') so the
  same resume never appears in both splits.

Usage:
    python -m ml.eval.import_kaggle_dataset ml/eval/datasets/kaggle_domain
"""

from __future__ import annotations

import csv
import hashlib
import re
import sys
from pathlib import Path

SOURCE_NAME = "source/resume_job_matching.csv"


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _split_for(resume_id: str) -> str:
    return "test" if int(hashlib.sha256(resume_id.encode()).hexdigest(), 16) % 10 < 4 else "tune"


def import_dataset(root: Path) -> int:
    csv.field_size_limit(10**8)
    with open(root / SOURCE_NAME, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    (root / "resumes").mkdir(exist_ok=True)
    (root / "jobs").mkdir(exist_ok=True)

    labels: list[dict[str, str]] = []
    for r in rows:
        resume_file = f"{r['resume_id']}.txt"
        job_file = f"job_{_slug(r['job_title'])}.txt"
        (root / "resumes" / resume_file).write_text(r["resume_text"], encoding="utf-8")
        (root / "jobs" / job_file).write_text(
            f"{r['job_title']}\n{r['job_description']}\n", encoding="utf-8"
        )
        if r["match_label"] not in ("0", "1"):
            continue
        labels.append(
            {
                "resume": resume_file,
                "job": job_file,
                "expected": "strong" if r["match_label"] == "1" else "weak",
                "reason": r["match_reason"],
                "split": _split_for(r["resume_id"]),
                "pair_type": r["pair_type"],
                "source_category": r["source_category"],
                "experience_level": r["experience_level"],
            }
        )

    with open(root / "labels.csv", "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(labels[0]))
        writer.writeheader()
        writer.writerows(labels)
    return len(labels)


if __name__ == "__main__":
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "ml/eval/datasets/kaggle_domain")
    print(f"Wrote {import_dataset(target)} labeled pairs to {target / 'labels.csv'}")
