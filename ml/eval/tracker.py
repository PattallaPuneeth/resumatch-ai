"""
ResuMatch AI - Evaluation Experiment Tracker (Phase 3 - Item 6)

Appends structured run metadata, dataset fingerprints, hyperparameter settings,
performance metrics, and 95% bootstrap confidence intervals to experiments.jsonl.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import logging
import subprocess
import uuid
from pathlib import Path
from typing import Any

from ml.eval.metrics import bootstrap_confidence_intervals

logger = logging.getLogger("resumatch-eval-tracker")

DEFAULT_EXPERIMENTS_PATH = Path("ml/eval/experiments.jsonl")


def get_git_info() -> dict[str, Any]:
    """Retrieves current git commit hash and working tree status."""
    sha = "unknown"
    dirty = False
    try:
        res = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if res.returncode == 0:
            sha = res.stdout.strip()

        status_res = subprocess.run(
            ["git", "status", "--porcelain"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if status_res.returncode == 0:
            dirty = bool(status_res.stdout.strip())
    except Exception as e:
        logger.debug("Failed to inspect git state: %s", e)

    return {"commit": sha, "dirty": dirty}


def compute_dataset_fingerprint(dataset_dir: Path | str) -> str:
    """Computes SHA-256 fingerprint over labels and core dataset files."""
    path = Path(dataset_dir)
    hasher = hashlib.sha256()

    files_to_hash: list[Path] = []
    if path.is_file():
        files_to_hash.append(path)
    elif path.is_dir():
        for fname in ["labels.csv", "manifest.csv", "dataset.csv"]:
            target = path / fname
            if target.exists():
                files_to_hash.append(target)
        if not files_to_hash:
            files_to_hash = sorted(
                [p for p in path.glob("*") if p.is_file() and p.suffix in [".csv", ".json", ".txt"]]
            )

    if not files_to_hash:
        return "empty_or_unknown"

    for file_path in sorted(files_to_hash):
        try:
            with open(file_path, "rb") as f:
                while chunk := f.read(65536):
                    hasher.update(chunk)
        except Exception as e:
            logger.warning("Could not read file for fingerprinting: %s (%s)", file_path, e)

    return hasher.hexdigest()[:16]


def record_eval_run(
    dataset_dir: Path | str,
    evaluated_pairs: list[dict[str, Any]],
    metrics: dict[str, Any],
    calibration_data: dict[str, Any] | None = None,
    custom_name: str | None = None,
    output_path: Path | str = DEFAULT_EXPERIMENTS_PATH,
) -> dict[str, Any]:
    """
    Appends an evaluation experiment record to the JSONL log.
    Includes 95% bootstrap confidence intervals for accuracy metrics.
    """
    git_info = get_git_info()
    fingerprint = compute_dataset_fingerprint(dataset_dir)
    timestamp_str = datetime.datetime.now(datetime.UTC).strftime("%Y%m%d_%H%M%S")
    run_id = f"run_{timestamp_str}_{uuid.uuid4().hex[:6]}"

    # Compute 95% confidence intervals
    ci_95 = bootstrap_confidence_intervals(evaluated_pairs)

    fitted_params = {}
    if calibration_data and "fitted_params" in calibration_data:
        fitted_params = calibration_data["fitted_params"]

    record = {
        "run_id": run_id,
        "name": custom_name or run_id,
        "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
        "git": git_info,
        "dataset": {
            "path": str(dataset_dir),
            "fingerprint": fingerprint,
            "sample_count": len(evaluated_pairs),
        },
        "models": {
            "embedder": "all-MiniLM-L6-v2",
            "reranker": "cross-encoder/ms-marco-MiniLM-L-6-v2",
            "chunk_size": 500,
            "chunk_overlap": 50,
        },
        "settings": {
            "strong_threshold": 75.0,
            "weak_threshold": 45.0,
            "weights": {
                "semantic": 0.60,
                "reranker": 0.30,
                "lexical": 0.10,
            },
            "calibration": fitted_params,
        },
        "metrics": {
            "pairwise_ordering_accuracy": metrics.get("pairwise_ordering_accuracy", 0.0),
            "label_accuracy": metrics.get("label_accuracy", 0.0),
            "mean_scores": metrics.get("mean_scores", {}),
            "label_gaps": metrics.get("label_gaps", {}),
        },
        "confidence_intervals_95": ci_95,
    }

    try:
        out_file = Path(output_path)
        out_file.parent.mkdir(parents=True, exist_ok=True)
        with open(out_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError:
        import tempfile

        out_file = Path(tempfile.gettempdir()) / "experiments.jsonl"
        with open(out_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    logger.info("Recorded evaluation run %s to %s", run_id, out_file)
    return record


def load_experiments(history_file: Path | str = DEFAULT_EXPERIMENTS_PATH) -> list[dict[str, Any]]:
    """Loads all tracked experiment runs from JSONL."""
    path = Path(history_file)
    if not path.exists():
        return []

    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return records
