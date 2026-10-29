"""
Tests for Phase 3 Experiment Tracking and Run Comparison (ml/eval/tracker.py & ml/eval/compare.py).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ml.eval.compare import generate_comparison_report
from ml.eval.tracker import (
    compute_dataset_fingerprint,
    load_experiments,
    record_eval_run,
)


def test_compute_dataset_fingerprint(tmp_path: Path) -> None:
    labels = tmp_path / "labels.csv"
    labels.write_text("resume,job,expected\nr1,j1,strong\nr2,j2,weak\n", encoding="utf-8")

    fp1 = compute_dataset_fingerprint(tmp_path)
    assert len(fp1) == 16

    # Changing content changes fingerprint
    labels.write_text("resume,job,expected\nr1,j1,strong\nr2,j2,medium\n", encoding="utf-8")
    fp2 = compute_dataset_fingerprint(tmp_path)
    assert fp2 != fp1


def test_record_eval_run_and_load(tmp_path: Path) -> None:
    exp_log = tmp_path / "experiments.jsonl"

    dataset_dir = tmp_path / "dataset"
    dataset_dir.mkdir()
    (dataset_dir / "labels.csv").write_text(
        "resume,job,expected\nr1,j1,strong\nr2,j2,weak\n", encoding="utf-8"
    )

    evaluated_pairs: list[dict[str, Any]] = [
        {"resume": "r1", "job": "j1", "expected": "strong", "final_score": 88.0},
        {"resume": "r2", "job": "j2", "expected": "weak", "final_score": 32.0},
        {"resume": "r3", "job": "j3", "expected": "medium", "final_score": 60.0},
    ]
    metrics = {
        "pairwise_ordering_accuracy": 1.0,
        "label_accuracy": 1.0,
        "mean_scores": {"strong": 88.0, "medium": 60.0, "weak": 32.0},
        "label_gaps": {"strong_to_medium": 28.0, "medium_to_weak": 28.0},
    }

    record = record_eval_run(
        dataset_dir=dataset_dir,
        evaluated_pairs=evaluated_pairs,
        metrics=metrics,
        custom_name="test_run_1",
        output_path=exp_log,
    )

    assert record["name"] == "test_run_1"
    assert "confidence_intervals_95" in record
    assert "models" in record
    assert record["models"]["embedder"] == "all-MiniLM-L6-v2"
    assert record["models"]["reranker"] == "cross-encoder/ms-marco-MiniLM-L-6-v2"

    history = load_experiments(exp_log)
    assert len(history) == 1
    assert history[0]["run_id"] == record["run_id"]


def test_compare_runs_noise_margin() -> None:
    run_a = {
        "run_id": "run_A",
        "timestamp": "2026-10-28T12:00:00Z",
        "dataset": {"fingerprint": "abc12345", "sample_count": 100},
        "metrics": {
            "pairwise_ordering_accuracy": 0.85,
            "label_accuracy": 0.65,
            "mean_scores": {"strong": 70.0, "medium": 58.0, "weak": 28.0},
            "label_gaps": {"strong_to_medium": 12.0, "medium_to_weak": 30.0},
        },
        "confidence_intervals_95": {
            "pairwise_ordering_accuracy": [0.81, 0.89],  # noise margin = 0.04 (4%)
            "label_accuracy": [0.58, 0.72],  # noise margin = 0.07 (7%)
        },
    }

    # Run B with small gain inside noise (+1.5% ordering, +2.0% label)
    run_b_noisy = {
        "run_id": "run_B_noisy",
        "timestamp": "2026-10-29T12:00:00Z",
        "dataset": {"fingerprint": "abc12345", "sample_count": 100},
        "metrics": {
            "pairwise_ordering_accuracy": 0.865,
            "label_accuracy": 0.67,
            "mean_scores": {"strong": 71.0, "medium": 59.0, "weak": 27.0},
            "label_gaps": {"strong_to_medium": 12.0, "medium_to_weak": 32.0},
        },
        "confidence_intervals_95": {
            "pairwise_ordering_accuracy": [0.82, 0.90],
            "label_accuracy": [0.60, 0.74],
        },
    }

    report = generate_comparison_report(run_a, run_b_noisy)
    assert "WITHIN NOISE" in report
    assert "IDENTICAL" in report

    # Run C with large significant gain (+8.0% ordering)
    run_c_significant = {
        "run_id": "run_C_significant",
        "timestamp": "2026-10-30T12:00:00Z",
        "dataset": {"fingerprint": "abc12345", "sample_count": 100},
        "metrics": {
            "pairwise_ordering_accuracy": 0.94,
            "label_accuracy": 0.80,
            "mean_scores": {"strong": 82.0, "medium": 60.0, "weak": 20.0},
            "label_gaps": {"strong_to_medium": 22.0, "medium_to_weak": 40.0},
        },
        "confidence_intervals_95": {
            "pairwise_ordering_accuracy": [0.90, 0.97],
            "label_accuracy": [0.73, 0.86],
        },
    }

    report2 = generate_comparison_report(run_a, run_c_significant)
    assert "SIGNIFICANT" in report2
    assert "IMPROVED" in report2
