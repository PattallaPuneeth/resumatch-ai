"""
ResuMatch AI - Evaluation Run Comparison CLI (Phase 3 - Item 6)

Compares two evaluation runs (by ID, file path, or --latest-2) and determines:
- Which metrics changed (ordering accuracy, classification accuracy, label gaps)
- Whether each metric delta is statistically significant or within the 95% bootstrap noise margin.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, cast

from ml.eval.tracker import DEFAULT_EXPERIMENTS_PATH, load_experiments


def load_run(identifier: str) -> dict[str, Any] | None:
    """Loads a run by file path or run_id from experiments.jsonl."""
    p = Path(identifier)
    if p.exists() and p.is_file():
        with open(p, encoding="utf-8") as f:
            data = cast(dict[str, Any], json.load(f))
            # If results.json format from eval suite
            if "metrics" in data and "run_id" not in data:
                return {
                    "run_id": p.name,
                    "timestamp": "from_file",
                    "dataset": {
                        "fingerprint": "n/a",
                        "sample_count": len(data.get("evaluated_pairs", [])),
                    },
                    "metrics": data["metrics"],
                    "confidence_intervals_95": {},
                    "models": {},
                    "settings": {},
                }
            return data

    # Search in experiments.jsonl
    experiments = load_experiments()
    for exp in experiments:
        if exp.get("run_id") == identifier or exp.get("name") == identifier:
            return exp

    # Prefix match
    for exp in experiments:
        if exp.get("run_id", "").startswith(identifier):
            return exp

    return None


def generate_comparison_report(run_a: dict[str, Any], run_b: dict[str, Any]) -> str:
    """Generates markdown comparison report between two runs."""
    id_a = run_a.get("run_id", "Run A")
    id_b = run_b.get("run_id", "Run B")
    date_a = run_a.get("timestamp", "unknown")
    date_b = run_b.get("timestamp", "unknown")

    fp_a = run_a.get("dataset", {}).get("fingerprint", "unknown")
    fp_b = run_b.get("dataset", {}).get("fingerprint", "unknown")
    same_dataset = fp_a == fp_b and fp_a != "unknown"

    lines = [
        "# ResuMatch AI — Evaluation Run Comparison Report",
        "",
        f"- **Baseline (Run A):** `{id_a}` ({date_a})",
        f"- **Candidate (Run B):** `{id_b}` ({date_b})",
        f"- **Dataset Fingerprint Match:** `{'IDENTICAL' if same_dataset else 'DIFFERENT'}`",
        f"  (A: `{fp_a}` vs B: `{fp_b}`)",
        "",
        "## 1. Metrics & Statistical Significance Against Noise",
        "",
        "| Metric | Run A | Run B | Delta | 95% Noise Margin (A) | Verdict |",
        "| :--- | :---: | :---: | :---: | :---: | :---: |",
    ]

    metrics_a = run_a.get("metrics", {})
    metrics_b = run_b.get("metrics", {})
    ci_a = run_a.get("confidence_intervals_95", {})

    compared_keys = [
        ("Pairwise Ordering Accuracy", "pairwise_ordering_accuracy", True),
        ("Label Accuracy (Classification)", "label_accuracy", True),
    ]

    for label, key, is_pct in compared_keys:
        val_a = metrics_a.get(key, 0.0)
        val_b = metrics_b.get(key, 0.0)
        delta = val_b - val_a

        ci = ci_a.get(key, [])
        noise_margin = (ci[1] - ci[0]) / 2.0 if len(ci) == 2 else None

        fmt_a = f"{val_a * 100:.1f}%" if is_pct else f"{val_a:.3f}"
        fmt_b = f"{val_b * 100:.1f}%" if is_pct else f"{val_b:.3f}"
        fmt_delta = (
            f"{'+' if delta >= 0 else ''}{delta * 100:.1f}%"
            if is_pct
            else f"{'+' if delta >= 0 else ''}{delta:.3f}"
        )

        if noise_margin is not None:
            fmt_noise = f"±{noise_margin * 100:.1f}%" if is_pct else f"±{noise_margin:.3f}"
            if abs(delta) > noise_margin:
                verdict = "**SIGNIFICANT** (" + ("IMPROVED" if delta > 0 else "REGRESSED") + ")"
            else:
                verdict = "WITHIN NOISE"
        else:
            fmt_noise = "n/a"
            verdict = "UNCALCULATED"

        lines.append(
            f"| **{label}** | {fmt_a} | {fmt_b} | `{fmt_delta}` | {fmt_noise} | {verdict} |"
        )

    # Mean score comparison
    means_a = metrics_a.get("mean_scores", {})
    means_b = metrics_b.get("mean_scores", {})
    lines.extend(
        [
            "",
            "## 2. Mean Score Distributions & Separation Gaps",
            "",
            "| Category | Run A | Run B | Delta |",
            "| :--- | :---: | :---: | :---: |",
        ]
    )
    for cat in ["strong", "medium", "weak"]:
        ma = means_a.get(cat, 0.0)
        mb = means_b.get(cat, 0.0)
        d = mb - ma
        sign = "+" if d >= 0 else ""
        lines.append(f"| Mean `{cat.upper()}` Score | {ma:.1f} | {mb:.1f} | `{sign}{d:.1f}` |")

    gaps_a = metrics_a.get("label_gaps", {})
    gaps_b = metrics_b.get("label_gaps", {})
    s_gap_a = gaps_a.get("strong_to_medium", 0.0)
    s_gap_b = gaps_b.get("strong_to_medium", 0.0)
    s_delta = s_gap_b - s_gap_a
    s_sign = "+" if s_delta >= 0 else ""

    m_gap_a = gaps_a.get("medium_to_weak", 0.0)
    m_gap_b = gaps_b.get("medium_to_weak", 0.0)
    m_delta = m_gap_b - m_gap_a
    m_sign = "+" if m_delta >= 0 else ""

    lines.extend(
        [
            f"| **Strong/Med Gap** | {s_gap_a:.1f} | {s_gap_b:.1f} | `{s_sign}{s_delta:.1f}` |",
            f"| **Medium-to-Weak Gap** | {m_gap_a:.1f} | {m_gap_b:.1f} | `{m_sign}{m_delta:.1f}` |",
        ]
    )

    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare two ResuMatch AI evaluation runs.")
    parser.add_argument("run_a", nargs="?", help="First run ID or results.json path")
    parser.add_argument("run_b", nargs="?", help="Second run ID or results.json path")
    parser.add_argument(
        "--latest-2", action="store_true", help="Compare the two most recent runs in history"
    )
    parser.add_argument(
        "--history-file", default=str(DEFAULT_EXPERIMENTS_PATH), help="Path to experiments.jsonl"
    )

    args = parser.parse_args()

    experiments = load_experiments(args.history_file)

    if getattr(args, "latest_2", False) or (not args.run_a and not args.run_b):
        if len(experiments) < 2:
            print(
                f"Error: Need at least 2 runs in {args.history_file} (found {len(experiments)}).",
                file=sys.stderr,
            )
            return 1
        run_a = experiments[-2]
        run_b = experiments[-1]
    else:
        if not args.run_a or not args.run_b:
            print("Error: Specify both run_a and run_b, or use --latest-2.", file=sys.stderr)
            return 1
        loaded_a = load_run(args.run_a)
        loaded_b = load_run(args.run_b)
        if not loaded_a:
            print(f"Error: Could not find run '{args.run_a}'.", file=sys.stderr)
            return 1
        if not loaded_b:
            print(f"Error: Could not find run '{args.run_b}'.", file=sys.stderr)
            return 1
        run_a = loaded_a
        run_b = loaded_b

    report = generate_comparison_report(run_a, run_b)
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
