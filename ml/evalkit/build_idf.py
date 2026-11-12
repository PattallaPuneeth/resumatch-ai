"""Build the frozen IDF table `ml/data/jd_idf_v1.json` from unlabeled job-description text.

Labels are never read. The table is a frozen reference so that scores do not drift when new
postings arrive; rebuild only with a new version name.

Usage (from the repo root):
    python -m ml.eval.build_idf --version v1 [--csv path ...] [--dir path ...]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter
from pathlib import Path

from ml.scoring.units import DATA, table_digest, term_set

DEFAULT_CSVS = ["8K-rows-dataset/train.csv", "8K-rows-dataset/test.csv"]
DEFAULT_DIRS = ["ml/eval/datasets/handwritten/jobs", "ml/eval/datasets/kaggle_domain/jobs"]
MIN_DF_UNIGRAM = 2
MIN_DF_BIGRAM = 3


def collect(csvs: list[str], dirs: list[str]) -> dict[str, str]:
    """sha256 -> text, deduplicated. Only job text is read."""
    docs: dict[str, str] = {}
    csv.field_size_limit(10**8)
    for path in csvs:
        p = Path(path)
        if not p.exists():
            continue
        with p.open(encoding="utf-8-sig", newline="") as fh:
            for row in csv.DictReader(fh):
                text = row.get("job_description_text") or ""
                if text.strip():
                    docs[hashlib.sha256(text.strip().encode()).hexdigest()] = text
    for directory in dirs:
        d = Path(directory)
        if d.exists():
            for f in sorted(d.glob("*.txt")):
                text = f.read_text(encoding="utf-8", errors="ignore")
                if text.strip():
                    docs[hashlib.sha256(text.strip().encode()).hexdigest()] = text
    return docs


def build(docs: dict[str, str], version: str) -> dict:
    df: Counter[str] = Counter()
    for text in docs.values():
        uni, bi = term_set(text)
        df.update(uni)
        df.update(bi)
    kept = {
        t: n for t, n in df.items() if n >= (MIN_DF_BIGRAM if " " in t else MIN_DF_UNIGRAM)
    }
    return {
        "version": version,
        "n_docs": len(docs),
        "corpus_sha256": hashlib.sha256("".join(sorted(docs)).encode()).hexdigest(),
        "min_df": {"unigram": MIN_DF_UNIGRAM, "bigram": MIN_DF_BIGRAM},
        "table_sha256": table_digest(kept),
        "df": dict(sorted(kept.items())),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="v1")
    ap.add_argument("--csv", action="append")
    ap.add_argument("--dir", action="append")
    ap.add_argument("--out", default=str(DATA / "jd_idf_v1.json"))
    args = ap.parse_args()
    docs = collect(args.csv or DEFAULT_CSVS, args.dir or DEFAULT_DIRS)
    if len(docs) < 50:
        raise SystemExit(f"only {len(docs)} job descriptions found; need at least 50")
    table = build(docs, args.version)
    Path(args.out).write_text(json.dumps(table, ensure_ascii=False), encoding="utf-8")
    print(f"wrote {args.out}: {table['n_docs']} job descriptions, {len(table['df'])} terms")


if __name__ == "__main__":
    main()
