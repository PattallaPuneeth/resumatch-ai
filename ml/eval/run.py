"""
CLI entrypoint for ResuMatch AI Evaluation Harness (Phase 3C-1).

Usage:
    python -m ml.eval.run --dataset test-data/ --output-dir eval-results/
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from ml.eval.runner import run_evaluation_suite

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("resumatch-ml-eval")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run ResuMatch AI matching evaluation benchmark and ablation study."
    )
    parser.add_argument(
        "--dataset",
        type=str,
        default="test-data",
        help="Path to evaluation dataset directory (default: test-data).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="eval-results",
        help="Directory to save results.json, results.csv, and report.md.",
    )
    parser.add_argument(
        "--cache-dir",
        type=str,
        default=None,
        help="Custom directory for caching parsed text and embeddings.",
    )
    parser.add_argument(
        "--split",
        type=str,
        default=None,
        help="Only evaluate labels.csv rows whose 'split' column equals this value (e.g. test).",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress printing markdown report to console.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    dataset_path = Path(args.dataset)

    if not dataset_path.exists():
        logger.error("Dataset path does not exist: %s", dataset_path)
        return 1

    try:
        logger.info("Executing evaluation on dataset: %s", dataset_path)
        output = run_evaluation_suite(
            dataset_dir=dataset_path,
            output_dir=args.output_dir,
            cache_dir=args.cache_dir,
            split=args.split,
        )

        if not args.quiet:
            print("\n" + output["markdown_report"] + "\n")

        logger.info(
            "Evaluation complete! Results saved to %s (Ordering Acc: %.1f%%)",
            args.output_dir,
            output["metrics"]["pairwise_ordering_accuracy"] * 100,
        )
        return 0

    except Exception as e:
        logger.exception("Evaluation suite failed: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
