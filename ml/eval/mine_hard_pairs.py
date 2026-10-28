"""
Hard-pair mining for human labeling.

Scores the kaggle_domain set (tune + test) and the extended set with the production eval path
(`ml.eval.runner.process_eval_pair`, disk-cached), ranks pairs by how informative a human label
would be, and writes a CSV labeling sheet. The human labels are meant for refitting only the
45/75 band thresholds, so hardness favours pairs near those edges and pairs where the model's
band and the auto label disagree.

No LLM calls and no database: everything runs on files.

Usage:
    python -m ml.eval.mine_hard_pairs --output ml/eval/labeling/hard_pairs_to_label.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import os
import re
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from ml.eval.dataset import load_and_validate_dataset
from ml.eval.metrics import (
    DEFAULT_STRONG_THRESHOLD,
    DEFAULT_WEAK_THRESHOLD,
    LABEL_RANK_ORDER,
)
from ml.eval.runner import EvaluationArtifactCache, process_eval_pair

logger = logging.getLogger("resumatch-ml-eval-mine")

KAGGLE_DIR = Path("ml/eval/datasets/kaggle_domain")
EXTENDED_DIR = Path("test-data/extended_dataset")
DEFAULT_OUTPUT = Path("ml/eval/labeling/hard_pairs_to_label.csv")

# A score this close to 45 or 75 could flip band under a small threshold change.
EDGE_WINDOW = 7.0
EXCERPT_CHARS = 600
EXTENDED_FIELD = "Extended (tech)"

# Hand-checked label errors in kaggle_domain (docs/eval/ML_FAILURE_ANALYSIS.md, section 2).
KNOWN_NOISE_PAIRS: frozenset[tuple[str, str]] = frozenset(
    {
        ("R0118.txt", "job_accountant.txt"),  # working accountant labeled weak ("A/R" missed)
        ("R0239.txt", "job_data_analyst.txt"),  # account manager labeled strong on SQL/Excel
    }
)

CSV_COLUMNS = [
    "pair_id",
    "field",
    "resume_id",
    "job_id",
    "resume_excerpt",
    "jd_excerpt",
    "model_score",
    "auto_label",
    "human_label",
    "notes",
]


@dataclass(frozen=True)
class Candidate:
    """One scored resume/JD pair from the candidate pool."""

    dataset: str
    split: str
    field: str
    resume: str
    job: str
    auto_label: str
    model_score: float

    @property
    def pair_id(self) -> str:
        return f"{self.dataset}:{self.split or '-'}:{self.resume}:{self.job}"


@dataclass(frozen=True)
class Hardness:
    model_band: str
    edge_distance: float
    near_edge: bool
    band_disagreement: int
    known_noise: bool
    score: float


def band_for_score(
    score: float,
    strong_threshold: float = DEFAULT_STRONG_THRESHOLD,
    weak_threshold: float = DEFAULT_WEAK_THRESHOLD,
) -> str:
    """Same banding as `ml.eval.metrics.calculate_label_accuracy`."""
    if score >= strong_threshold:
        return "strong"
    if score >= weak_threshold:
        return "medium"
    return "weak"


def compute_hardness(
    cand: Candidate,
    known_noise: frozenset[tuple[str, str]] = KNOWN_NOISE_PAIRS,
    window: float = EDGE_WINDOW,
) -> Hardness:
    """
    Hardness = 3 x known_noise + band distance between model and auto label (0-2)
    + edge closeness (1 at an edge, falling to 0 at `window` points away, 0 beyond).
    """
    band = band_for_score(cand.model_score)
    edge_distance = min(
        abs(cand.model_score - DEFAULT_WEAK_THRESHOLD),
        abs(cand.model_score - DEFAULT_STRONG_THRESHOLD),
    )
    near_edge = edge_distance <= window
    disagreement = abs(LABEL_RANK_ORDER[band] - LABEL_RANK_ORDER[cand.auto_label])
    is_noise = (cand.resume, cand.job) in known_noise
    closeness = (1.0 - edge_distance / window) if near_edge else 0.0
    score = 3.0 * is_noise + disagreement + closeness
    return Hardness(
        model_band=band,
        edge_distance=round(edge_distance, 4),
        near_edge=near_edge,
        band_disagreement=disagreement,
        known_noise=is_noise,
        score=round(score, 6),
    )


def _rank_key(item: tuple[Candidate, Hardness]) -> tuple[float, int, float, str]:
    cand, h = item
    return (-h.score, -h.band_disagreement, h.edge_distance, cand.pair_id)


def _field_quotas(fields: Sequence[str], total: int) -> dict[str, int]:
    base, extra = divmod(total, len(fields))
    return {f: base + (1 if i < extra else 0) for i, f in enumerate(sorted(fields))}


def select_hard_pairs(
    candidates: Iterable[Candidate],
    n: int = 50,
    extended_quota: int = 8,
    known_noise: frozenset[tuple[str, str]] = KNOWN_NOISE_PAIRS,
) -> list[tuple[Candidate, Hardness]]:
    """
    Picks `n` pairs: known-noise pairs first, then the hardest per field.

    The extended set gets `extended_quota` slots (its tech roles sit outside the six Kaggle
    fields); the rest is split evenly across the Kaggle fields. Slots a field cannot fill go
    to the hardest leftovers from any field. Output is sorted by field, then hardness.
    """
    scored = sorted(((c, compute_hardness(c, known_noise)) for c in candidates), key=_rank_key)
    by_field: dict[str, list[tuple[Candidate, Hardness]]] = {}
    for item in scored:
        by_field.setdefault(item[0].field, []).append(item)

    kaggle_fields = [f for f in by_field if f != EXTENDED_FIELD]
    ext_slots = min(extended_quota, len(by_field.get(EXTENDED_FIELD, [])), n)
    quotas = _field_quotas(kaggle_fields, n - ext_slots) if kaggle_fields else {}
    if EXTENDED_FIELD in by_field:
        quotas[EXTENDED_FIELD] = ext_slots

    chosen: dict[str, tuple[Candidate, Hardness]] = {}
    for item in scored:
        if item[1].known_noise and len(chosen) < n:
            chosen[item[0].pair_id] = item

    for field in sorted(by_field):
        taken = sum(1 for c, _ in chosen.values() if c.field == field)
        for item in by_field[field]:
            if taken >= quotas.get(field, 0) or len(chosen) >= n:
                break
            if item[0].pair_id not in chosen:
                chosen[item[0].pair_id] = item
                taken += 1

    for item in scored:
        if len(chosen) >= n:
            break
        chosen.setdefault(item[0].pair_id, item)

    return sorted(chosen.values(), key=lambda it: (it[0].field, *_rank_key(it)))


def _excerpt(path: Path, limit: int = EXCERPT_CHARS) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _read_label_meta(dataset_dir: Path) -> dict[tuple[str, str], dict[str, str]]:
    with open(dataset_dir / "labels.csv", encoding="utf-8-sig") as f:
        return {(r["resume"].strip(), r["job"].strip()): r for r in csv.DictReader(f)}


def score_pool(
    pools: Sequence[tuple[str, Path]], scores_file: Path | None = None
) -> list[Candidate]:
    """Scores every labeled pair with the production eval path, cached in <dataset>/.eval_cache."""
    if scores_file and scores_file.exists():
        logger.info("Loading scored pool from %s", scores_file)
        rows = json.loads(scores_file.read_text(encoding="utf-8"))
        return [Candidate(**r) for r in rows]

    out: list[Candidate] = []
    for name, root in pools:
        meta = _read_label_meta(root)
        cache = EvaluationArtifactCache(root / ".eval_cache")
        examples = load_and_validate_dataset(root)
        for i, ex in enumerate(examples, start=1):
            row = meta[(ex.resume_name, ex.job_name)]
            res = process_eval_pair(ex, cache)
            out.append(
                Candidate(
                    dataset=name,
                    split=row.get("split", "").strip(),
                    field=row.get("source_category", "").strip() or EXTENDED_FIELD,
                    resume=ex.resume_name,
                    job=ex.job_name,
                    auto_label=ex.expected,
                    model_score=round(float(res["final_score"]), 2),
                )
            )
            if i % 50 == 0:
                logger.info("%s: scored %d/%d", name, i, len(examples))

    if scores_file:
        scores_file.parent.mkdir(parents=True, exist_ok=True)
        scores_file.write_text(json.dumps([asdict(c) for c in out], indent=1), encoding="utf-8")
    return out


def _git_state() -> dict[str, Any]:
    try:
        head = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", "ml"], capture_output=True, text=True
        ).stdout.strip()
        return {"commit": head, "ml_tree_dirty": bool(dirty)}
    except (OSError, subprocess.CalledProcessError):
        # The ML image has no git; the docker command passes the host's state instead.
        dirty_env = os.environ.get("GIT_ML_DIRTY")
        return {
            "commit": os.environ.get("GIT_COMMIT"),
            "ml_tree_dirty": None if dirty_env is None else dirty_env == "1",
        }


def write_labeling_sheet(
    selected: Sequence[tuple[Candidate, Hardness]],
    roots: dict[str, Path],
    output: Path,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_COLUMNS)
        writer.writeheader()
        for cand, _ in selected:
            root = roots[cand.dataset]
            writer.writerow(
                {
                    "pair_id": cand.pair_id,
                    "field": cand.field,
                    "resume_id": Path(cand.resume).stem,
                    "job_id": Path(cand.job).stem,
                    "resume_excerpt": _excerpt(root / "resumes" / cand.resume),
                    "jd_excerpt": _excerpt(root / "jobs" / cand.job),
                    "model_score": f"{cand.model_score:.1f}",
                    "auto_label": cand.auto_label,
                    "human_label": "",
                    "notes": "",
                }
            )

    # Why each row was picked, kept out of the sheet so the labeler is not anchored by it.
    sidecar = output.with_name(output.stem + "_selection.json")
    sidecar.write_text(
        json.dumps(
            {
                "git": _git_state(),
                "edge_window": EDGE_WINDOW,
                "thresholds": [DEFAULT_WEAK_THRESHOLD, DEFAULT_STRONG_THRESHOLD],
                "rows": [
                    {"pair_id": c.pair_id, "split": c.split, **asdict(h)} for c, h in selected
                ],
            },
            indent=1,
        ),
        encoding="utf-8",
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mine hard resume/JD pairs for human labeling.")
    p.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    p.add_argument("-n", type=int, default=50, help="Number of pairs to select.")
    p.add_argument("--extended-quota", type=int, default=8)
    p.add_argument("--kaggle-dir", type=Path, default=KAGGLE_DIR)
    p.add_argument("--extended-dir", type=Path, default=EXTENDED_DIR)
    p.add_argument(
        "--scores-file",
        type=Path,
        default=None,
        help="Reuse scored pool from this JSON if it exists, else write it there.",
    )
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    args = parse_args(argv)
    roots = {"kaggle_domain": args.kaggle_dir, "extended": args.extended_dir}
    pools = [(name, root) for name, root in roots.items() if (root / "labels.csv").exists()]
    if "extended" not in dict(pools):
        logger.warning("Extended set not found at %s; skipping it", args.extended_dir)

    candidates = score_pool(pools, args.scores_file)
    selected = select_hard_pairs(candidates, n=args.n, extended_quota=args.extended_quota)
    write_labeling_sheet(selected, roots, args.output)

    near = sum(1 for _, h in selected if h.near_edge)
    disagree = sum(1 for _, h in selected if h.band_disagreement)
    logger.info(
        "Wrote %d rows to %s (pool %d; near edge %d, band disagreement %d)",
        len(selected),
        args.output,
        len(candidates),
        near,
        disagree,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
