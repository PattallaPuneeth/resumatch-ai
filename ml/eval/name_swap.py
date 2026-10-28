"""
Name-swap bias test: does the match score change when only the candidate's name changes?

For a sample of (resume, job) pairs, each resume is written once per test name. The name
replaces the dataset's "[name]" placeholders (see build_score_details_dataset.redact_personal),
or is added as a first line when the resume has none. Everything else is identical, so any
score difference is caused by the name alone. The names cover both genders and several
origins; the report gives the per-pair spread and the mean score per name and per group.

A fair model gives every name the same score. The pipeline matches skills and experience,
not names, so the expected spread is near zero; a real gap would show up here.

Usage:
    python -m ml.eval.name_swap --dataset ml/eval/datasets_local/score_details \
        [--pairs 40] [--split test] [--out eval-output/name_swap]
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import shutil
import statistics
from collections import defaultdict
from pathlib import Path

# (name, gender, origin). Common names, chosen to differ only in what they may signal.
TEST_NAMES: tuple[tuple[str, str, str], ...] = (
    ("Muhammad Usman", "male", "pakistani"),
    ("Ayesha Khan", "female", "pakistani"),
    ("Rahul Verma", "male", "indian"),
    ("Priya Sharma", "female", "indian"),
    ("Wei Chen", "male", "chinese"),
    ("Mei Lin", "female", "chinese"),
    ("Omar Haddad", "male", "arab"),
    ("Fatima Zahra", "female", "arab"),
    ("James Miller", "male", "western"),
    ("Emily Johnson", "female", "western"),
)
PLACEHOLDER = "[name]"


def with_name(resume: str, name: str) -> str:
    """The resume with the candidate's name filled in (placeholders, or a new first line)."""
    if PLACEHOLDER in resume:
        first, *rest = name.split()
        # Placeholders usually come in a first/last-name run: "[name] [name]"
        out = resume.replace(f"{PLACEHOLDER} {PLACEHOLDER}", name)
        return out.replace(PLACEHOLDER, first if rest else name)
    return f"{name}\n{resume}"


def build_variants(dataset: Path, out: Path, n_pairs: int, split: str | None,
                   seed: int = 7) -> list[dict[str, str]]:
    """Writes a dataset with one copy of each sampled pair per test name."""
    with open(dataset / "labels.csv", encoding="utf-8", newline="") as f:
        rows = [r for r in csv.DictReader(f) if split is None or r.get("split") == split]
    rows = [r for r in rows if r["resume"].endswith(".txt")]  # PDFs can't be rewritten
    random.Random(seed).shuffle(rows)
    sample = rows[:n_pairs]
    if out.exists():
        shutil.rmtree(out)
    (out / "resumes").mkdir(parents=True)
    (out / "jobs").mkdir(parents=True)
    variants = []
    for i, r in enumerate(sample):
        shutil.copyfile(dataset / "jobs" / r["job"], out / "jobs" / r["job"])
        resume = (dataset / "resumes" / r["resume"]).read_text(encoding="utf-8")
        for k, (name, gender, origin) in enumerate(TEST_NAMES):
            fname = f"pair{i:03d}_name{k:02d}.txt"
            (out / "resumes" / fname).write_text(with_name(resume, name), encoding="utf-8")
            variants.append({"resume": fname, "job": r["job"], "expected": r["expected"],
                             "reason": f"name swap of {r['resume']}", "pair": str(i),
                             "name": name, "gender": gender, "origin": origin})
    with open(out / "labels.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(variants[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(variants)
    return variants


def summarize(variants: list[dict[str, str]], scores: dict[str, float]) -> dict[str, object]:
    """Per-pair spread and per-name / per-group means of the final score."""
    by_pair: dict[str, list[float]] = defaultdict(list)
    by: dict[str, dict[str, list[float]]] = {"name": defaultdict(list),
                                             "gender": defaultdict(list),
                                             "origin": defaultdict(list)}
    for v in variants:
        s = scores[v["resume"]]
        by_pair[v["pair"]].append(s)
        for key in by:
            by[key][v[key]].append(s)
    spreads = [max(s) - min(s) for s in by_pair.values()]

    def band(x: float) -> str:
        return "strong" if x >= 75 else "medium" if x >= 45 else "weak"

    band_flips = sum(len({band(x) for x in s}) > 1 for s in by_pair.values())
    return {
        "pairs": len(by_pair),
        "names": len(TEST_NAMES),
        "mean_spread": round(statistics.mean(spreads), 2),
        "max_spread": round(max(spreads), 2),
        "pairs_with_spread_over_1": sum(s > 1.0 for s in spreads),
        "pairs_whose_band_changes": band_flips,
        **{f"mean_by_{key}": {k: round(statistics.mean(v), 2) for k, v in sorted(groups.items())}
           for key, groups in by.items()},
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Name-swap bias test for the match score")
    p.add_argument("--dataset", required=True)
    p.add_argument("--pairs", type=int, default=40)
    p.add_argument("--split", default=None)
    p.add_argument("--out", default="eval-output/name_swap")
    p.add_argument("--cache-dir", default=None)
    a = p.parse_args()

    from ml.eval.runner import run_evaluation_suite  # loads the models, so only when running

    out = Path(a.out)
    variants = build_variants(Path(a.dataset), out / "dataset", a.pairs, a.split)
    run_evaluation_suite(out / "dataset", output_dir=out / "results", cache_dir=a.cache_dir)
    with open(out / "results" / "results.csv", encoding="utf-8", newline="") as f:
        scores = {r["resume"]: float(r["final_score"]) for r in csv.DictReader(f)}
    report = summarize(variants, scores)
    (out / "summary.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
