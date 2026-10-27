"""
Tests for ResuMatch AI Evaluation Harness (Phase 3C-1).

Verifies:
1. Dataset validation (missing files, bad labels, duplicates, malformed CSV).
2. Evaluation metrics (pairwise ordering accuracy, label classification accuracy,
   mean scores, label gaps).
3. Ablation analysis (6 configurations, metric extraction, markdown formatting, synthetic label).
4. Calibration routine (split determinism, parameter search, baseline comparison).
5. End-to-end harness run on built-in synthetic fixture with artifact caching.
"""

from __future__ import annotations

import csv
from pathlib import Path

import pytest

from ml.eval.ablation import extract_ablation_score, run_ablation_analysis
from ml.eval.calibration import (
    deterministic_train_heldout_split,
    fit_calibration_on_train,
)
from ml.eval.dataset import (
    DatasetValidationError,
    load_and_validate_dataset,
)
from ml.eval.metrics import (
    calculate_label_accuracy,
    calculate_label_gaps,
    calculate_mean_scores_per_label,
    calculate_pairwise_ordering_accuracy,
)
from ml.eval.runner import run_evaluation_suite

FIXTURE_DATASET_DIR = Path(__file__).parent / "fixtures" / "eval_dataset"


# ==============================================================================
# 1. Dataset Validation Tests
# ==============================================================================


def test_load_valid_fixture_dataset() -> None:
    examples = load_and_validate_dataset(FIXTURE_DATASET_DIR)
    assert len(examples) == 5
    pair_names = {(e.resume_name, e.job_name) for e in examples}
    assert ("resume_senior_backend.pdf", "job_backend_lead.txt") in pair_names
    assert ("resume_frontend_dev.pdf", "job_frontend_dev.txt") in pair_names


def test_dataset_validation_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        load_and_validate_dataset(tmp_path / "nonexistent_dir")


def test_dataset_validation_missing_labels_csv(tmp_path: Path) -> None:
    (tmp_path / "resumes").mkdir()
    (tmp_path / "jobs").mkdir()
    with pytest.raises(FileNotFoundError, match="Missing required 'labels.csv'"):
        load_and_validate_dataset(tmp_path)


def test_dataset_validation_missing_subdirectories(tmp_path: Path) -> None:
    (tmp_path / "labels.csv").write_text("resume,job,expected,reason\n", encoding="utf-8")
    with pytest.raises(DatasetValidationError, match="Missing required 'resumes' directory"):
        load_and_validate_dataset(tmp_path)


def test_dataset_validation_missing_columns(tmp_path: Path) -> None:
    (tmp_path / "resumes").mkdir()
    (tmp_path / "jobs").mkdir()
    (tmp_path / "labels.csv").write_text(
        "resume,job,expected\n", encoding="utf-8"
    )  # missing reason
    with pytest.raises(DatasetValidationError, match="missing required column"):
        load_and_validate_dataset(tmp_path)


def test_dataset_validation_invalid_label(tmp_path: Path) -> None:
    (tmp_path / "resumes").mkdir()
    (tmp_path / "jobs").mkdir()
    (tmp_path / "resumes" / "test.pdf").write_text("dummy", encoding="utf-8")
    (tmp_path / "jobs" / "job.txt").write_text("dummy", encoding="utf-8")
    (tmp_path / "labels.csv").write_text(
        "resume,job,expected,reason\ntest.pdf,job.txt,exceptional,invalid label test\n",
        encoding="utf-8",
    )
    with pytest.raises(DatasetValidationError, match="Invalid label 'exceptional'"):
        load_and_validate_dataset(tmp_path)


def test_dataset_validation_duplicate_pair(tmp_path: Path) -> None:
    (tmp_path / "resumes").mkdir()
    (tmp_path / "jobs").mkdir()
    (tmp_path / "resumes" / "test.pdf").write_text("dummy", encoding="utf-8")
    (tmp_path / "jobs" / "job.txt").write_text("dummy", encoding="utf-8")
    (tmp_path / "labels.csv").write_text(
        "resume,job,expected,reason\n"
        "test.pdf,job.txt,strong,first entry\n"
        "test.pdf,job.txt,medium,duplicate entry\n",
        encoding="utf-8",
    )
    with pytest.raises(DatasetValidationError, match="Duplicate pair detected"):
        load_and_validate_dataset(tmp_path)


def test_dataset_validation_referenced_file_not_found(tmp_path: Path) -> None:
    (tmp_path / "resumes").mkdir()
    (tmp_path / "jobs").mkdir()
    (tmp_path / "labels.csv").write_text(
        "resume,job,expected,reason\nmissing.pdf,missing.txt,strong,missing file test\n",
        encoding="utf-8",
    )
    with pytest.raises(DatasetValidationError, match="Referenced resume file not found"):
        load_and_validate_dataset(tmp_path)


# ==============================================================================
# 2. Evaluation Metrics Tests
# ==============================================================================


def test_pairwise_ordering_accuracy_perfect() -> None:
    items = [
        {"expected": "strong", "score": 90.0},
        {"expected": "medium", "score": 60.0},
        {"expected": "weak", "score": 20.0},
    ]
    acc = calculate_pairwise_ordering_accuracy(items, score_key="score")
    assert acc == 1.0


def test_pairwise_ordering_accuracy_inverted() -> None:
    items = [
        {"expected": "strong", "score": 20.0},
        {"expected": "medium", "score": 60.0},
        {"expected": "weak", "score": 90.0},
    ]
    acc = calculate_pairwise_ordering_accuracy(items, score_key="score")
    assert acc == 0.0


def test_pairwise_ordering_accuracy_ties() -> None:
    items = [
        {"expected": "strong", "score": 80.0},
        {"expected": "medium", "score": 80.0},  # tie = 0.5 points
        {"expected": "weak", "score": 20.0},
    ]
    acc = calculate_pairwise_ordering_accuracy(items, score_key="score")
    # Comparisons:
    # (strong, medium): 80 vs 80 -> tie (0.5)
    # (strong, weak): 80 vs 20 -> correct (1.0)
    # (medium, weak): 80 vs 20 -> correct (1.0)
    # Total points = 2.5 / 3 = 0.8333
    assert pytest.approx(acc, 0.01) == 0.8333


def test_mean_scores_and_gaps() -> None:
    items = [
        {"expected": "strong", "score": 95.0},
        {"expected": "strong", "score": 85.0},
        {"expected": "medium", "score": 60.0},
        {"expected": "weak", "score": 10.0},
    ]
    means = calculate_mean_scores_per_label(items, score_key="score")
    assert means["strong"] == 90.0
    assert means["medium"] == 60.0
    assert means["weak"] == 10.0

    gaps = calculate_label_gaps(means)
    assert gaps["strong_to_medium"] == 30.0
    assert gaps["medium_to_weak"] == 50.0
    assert gaps["strong_to_weak"] == 80.0


def test_label_classification_accuracy() -> None:
    items = [
        {"expected": "strong", "score": 85.0},  # correct (>= 75)
        {"expected": "medium", "score": 55.0},  # correct (>= 45 and < 75)
        {"expected": "weak", "score": 25.0},  # correct (< 45)
        {"expected": "strong", "score": 50.0},  # wrong (predicted medium)
    ]
    acc = calculate_label_accuracy(
        items, score_key="score", strong_threshold=75.0, weak_threshold=45.0
    )
    assert acc == 0.75


# ==============================================================================
# 3. Ablation Analysis Tests
# ==============================================================================


def test_ablation_score_extraction() -> None:
    sample = {
        "lexical_score": 0.5,
        "semantic_score": 0.8,
        "rrf_score": 0.02,
        "calibrated_ce_score": 85.0,
        "skill_coverage": 1.0,
    }
    assert extract_ablation_score(sample, "lexical_only") == 30.0
    assert extract_ablation_score(sample, "semantic_only") == 80.0
    assert extract_ablation_score(sample, "hybrid") == 55.0
    assert extract_ablation_score(sample, "rrf_cross_encoder") == 85.0
    assert extract_ablation_score(sample, "plus_skill_gap") == 89.5
    assert extract_ablation_score(sample, "full_blend") == 88.25


def test_ablation_unknown_coverage_drops_skill_term() -> None:
    """A job with no known requirements must not get free skill points in any blend."""
    sample = {
        "lexical_score": 0.5,
        "semantic_score": 0.8,
        "calibrated_ce_score": 85.0,
        "skill_coverage": None,
    }
    assert extract_ablation_score(sample, "plus_skill_gap") == 85.0
    # (0.65 * 85 + 0.10 * 80) / 0.75
    assert extract_ablation_score(sample, "full_blend") == 84.33


def test_ablation_analysis_output_structure() -> None:
    pairs = [
        {
            "expected": "strong",
            "lexical_score": 0.8,
            "semantic_score": 0.8,
            "rrf_score": 0.03,
            "calibrated_ce_score": 90.0,
            "skill_coverage": 1.0,
        },
        {
            "expected": "weak",
            "lexical_score": 0.1,
            "semantic_score": 0.3,
            "rrf_score": 0.01,
            "calibrated_ce_score": 15.0,
            "skill_coverage": 0.0,
        },
    ]
    res = run_ablation_analysis(pairs)
    assert len(res["results"]) == 6
    assert "### Ablation Study (Synthetic Evaluation Dataset)" in res["markdown_table"]
    assert "Synthetic Evaluation Dataset" in res["markdown_table"]


# ==============================================================================
# 4. Calibration Optimization Tests
# ==============================================================================


def test_split_determinism() -> None:
    examples = [
        {"id": f"ex_{i}", "expected": "strong" if i < 3 else ("medium" if i < 6 else "weak")}
        for i in range(10)
    ]
    train1, held1 = deterministic_train_heldout_split(examples, seed=42)
    train2, held2 = deterministic_train_heldout_split(examples, seed=42)
    train_diff_seed, _ = deterministic_train_heldout_split(examples, seed=999)

    assert [e["id"] for e in train1] == [e["id"] for e in train2]
    assert [e["id"] for e in held1] == [e["id"] for e in held2]
    assert [e["id"] for e in train1] != [e["id"] for e in train_diff_seed]


def test_calibration_optimizer_fit() -> None:
    train_examples = [
        {
            "cross_encoder_logit": 3.0,
            "skill_coverage": 1.0,
            "semantic_score": 0.8,
            "expected": "strong",
        },
        {
            "cross_encoder_logit": -1.0,
            "skill_coverage": 0.5,
            "semantic_score": 0.6,
            "expected": "medium",
        },
        {
            "cross_encoder_logit": -10.0,
            "skill_coverage": 0.0,
            "semantic_score": 0.2,
            "expected": "weak",
        },
    ]
    params = fit_calibration_on_train(train_examples)
    assert "shift" in params
    assert "temp" in params
    assert "w_ce" in params


# ==============================================================================
# 5. End-to-End Evaluation Harness Test (Built-in Fixture)
# ==============================================================================


def test_run_evaluation_suite_end_to_end(tmp_path: Path) -> None:
    out_dir = tmp_path / "eval_out"
    cache_dir = tmp_path / "eval_cache"

    res = run_evaluation_suite(
        dataset_dir=FIXTURE_DATASET_DIR,
        output_dir=out_dir,
        cache_dir=cache_dir,
    )

    # 1. Output files created
    assert (out_dir / "results.json").exists()
    assert (out_dir / "results.csv").exists()
    assert (out_dir / "report.md").exists()

    # 2. Benchmark metrics
    m = res["metrics"]
    assert m["pairwise_ordering_accuracy"] == 1.0  # Perfect separation on fixture
    assert m["mean_scores"]["strong"] > m["mean_scores"]["medium"]
    assert m["mean_scores"]["medium"] > m["mean_scores"]["weak"]

    # 3. CSV contents
    with open(out_dir / "results.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
        assert len(rows) == 5

    # 4. Cache files created
    cache_files = list(cache_dir.glob("*.json"))
    assert len(cache_files) >= 5  # 3 resumes + 2 jobs cached
