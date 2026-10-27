"""
Phase 10A - Item D3: CI Evaluation Gate

Evaluates candidate ranking quality against a committed baseline:
- Validates pairwise ordering accuracy against min_pairwise_accuracy
- Validates strong label separation vs weak label ceiling
- Exits 0 on clean pass; exits 1 with regression diagnostics on failure
- Supports --simulate-regression to prove the gate blocks degrading changes
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ml.eval.runner import run_evaluation_suite


def run_eval_gate(
    fixture_dir: str = "ml/eval/ci_fixtures",
    baseline_path: str = "ml/eval/ci_fixtures/baseline.json",
    simulate_regression: bool = False,
) -> bool:
    print("\n=================== ResuMatch AI — CI Eval Gate ===================")
    print(f"Fixture directory: {fixture_dir}")
    print(f"Baseline path:     {baseline_path}")

    if not os.path.exists(fixture_dir):
        print(f"ERROR: Fixture directory does not exist: {fixture_dir}")
        return False

    if not os.path.exists(baseline_path):
        print(f"ERROR: Baseline file does not exist: {baseline_path}")
        return False

    with open(baseline_path, encoding="utf-8") as f:
        baseline = json.load(f)

    # Execute evaluation pipeline
    eval_output_dir = "/tmp/eval_gate_output" if os.path.exists("/tmp") else "./tmp/eval_gate_output"
    cache_dir = "/tmp/eval_gate_cache" if os.path.exists("/tmp") else "./tmp/eval_gate_cache"

    print("Running evaluation pipeline on fixtures...")
    eval_report = run_evaluation_suite(
        dataset_dir=fixture_dir,
        output_dir=eval_output_dir,
        cache_dir=cache_dir,
    )

    metrics = eval_report["metrics"]
    actual_pairwise = metrics.get("pairwise_ordering_accuracy", 0.0)
    mean_scores = metrics.get("mean_scores", {})
    actual_strong = mean_scores.get("strong", 0.0)
    actual_weak = mean_scores.get("weak", 0.0)
    actual_gap = actual_strong - actual_weak

    if simulate_regression:
        print("\n[SIMULATED REGRESSION ACTIVE]: artifically degrading measured metrics by 30%")
        actual_pairwise = max(0.0, actual_pairwise - 0.35)
        actual_strong = max(0.0, actual_strong - 25.0)
        actual_gap = actual_strong - actual_weak

    min_pairwise = baseline.get("min_pairwise_accuracy", 0.83)
    min_strong = baseline.get("min_strong_mean_score", 60.0)
    max_weak = baseline.get("max_weak_mean_score", 45.0)
    min_gap = baseline.get("min_strong_to_weak_gap", 20.0)

    print("\n---------------- Metric Comparison vs Baseline ----------------")
    print(f"  • Pairwise Ordering Accuracy: {actual_pairwise:.2%} (Threshold: >= {min_pairwise:.2%})")
    print(f"  • Strong Mean Score:          {actual_strong:.1f} (Threshold: >= {min_strong:.1f})")
    print(f"  • Weak Mean Score:            {actual_weak:.1f} (Threshold: <= {max_weak:.1f})")
    print(f"  • Strong-to-Weak Separation:  {actual_gap:.1f} pts (Threshold: >= {min_gap:.1f} pts)")
    print("----------------------------------------------------------------\n")

    regressions: list[str] = []
    if actual_pairwise < min_pairwise:
        regressions.append(
            f"Pairwise accuracy degraded below threshold: {actual_pairwise:.2%} < {min_pairwise:.2%}"
        )
    if actual_strong < min_strong:
        regressions.append(
            f"Strong candidate mean score degraded: {actual_strong:.1f} < {min_strong:.1f}"
        )
    if actual_weak > max_weak:
        regressions.append(
            f"Weak candidate score exceeded ceiling: {actual_weak:.1f} > {max_weak:.1f}"
        )
    if actual_gap < min_gap:
        regressions.append(
            f"Label separation gap collapsed: {actual_gap:.1f} pts < {min_gap:.1f} pts"
        )

    if regressions:
        print("❌ CI EVAL GATE FAILED: Regressions detected:")
        for r in regressions:
            print(f"   - {r}")
        print("================================================================\n")
        return False

    print("✅ CI EVAL GATE PASSED: All metrics satisfied production baselines.")
    print("================================================================\n")
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="CI Evaluation Quality Gate")
    parser.add_argument("--fixture-dir", default="ml/eval/ci_fixtures", help="Fixture directory")
    parser.add_argument("--baseline", default="ml/eval/ci_fixtures/baseline.json", help="Baseline path")
    parser.add_argument("--simulate-regression", action="store_true", help="Simulate a regression to test failure exit")

    args = parser.parse_args()
    success = run_eval_gate(
        fixture_dir=args.fixture_dir,
        baseline_path=args.baseline,
        simulate_regression=args.simulate_regression,
    )
    sys.exit(0 if success else 1)
