"""
Imports the hand-labeled hard pairs (ml/eval/labeling/) as an eval dataset.

Reads the labeling sheet (.xlsx or .csv, columns as in hard_pairs_to_label.csv), validates every
row and writes ml/eval/datasets/human_hard/ in the standard layout (resumes/, jobs/, labels.csv),
so it runs through the same harness as every other dataset.

The `split` column keeps the provenance honest: pairs taken from the kaggle_domain *test* split
are `test`; everything else is `tune`. Anything fitted on these labels must be reported on the
`test` rows separately, because those pairs were already used as a held-out benchmark.

Usage:
    python -m ml.eval.import_human_labels [--sheet ml/eval/labeling/hard_pairs_labeled.xlsx]
"""

from __future__ import annotations

import argparse
import csv
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

VALID_LABELS = ("strong", "medium", "weak")
SOURCE_DIRS = {
    "kaggle_domain": Path("ml/eval/datasets/kaggle_domain"),
    "extended": Path("test-data/extended_dataset"),
}
_XLSX_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


class LabelImportError(ValueError):
    pass


def _col_index(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):  # type: ignore[union-attr]
        n = n * 26 + ord(ch) - 64
    return n - 1


def read_xlsx(path: Path) -> list[dict[str, str]]:
    """First sheet of an .xlsx as dict rows, using only the standard library."""
    with zipfile.ZipFile(path) as z:
        shared: list[str] = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(f"{_XLSX_NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{_XLSX_NS}t")))
        sheets = sorted(n for n in z.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
        if not sheets:
            raise LabelImportError(f"{path} has no worksheet")
        root = ET.fromstring(z.read(sheets[0]))

    table: list[list[str]] = []
    for row in root.iter(f"{_XLSX_NS}row"):
        cells: dict[int, str] = {}
        for c in row.iter(f"{_XLSX_NS}c"):
            kind, v = c.get("t"), c.find(f"{_XLSX_NS}v")
            if kind == "s" and v is not None and v.text is not None:
                value = shared[int(v.text)]
            elif kind == "inlineStr":
                value = "".join(t.text or "" for t in c.iter(f"{_XLSX_NS}t"))
            else:
                value = v.text if v is not None and v.text is not None else ""
            cells[_col_index(c.get("r", "A"))] = value
        if cells:
            table.append([cells.get(i, "") for i in range(max(cells) + 1)])
    header = [h.strip() for h in table[0]]
    return [dict(zip(header, r + [""] * (len(header) - len(r)), strict=False)) for r in table[1:]]


def read_sheet(path: Path) -> list[dict[str, str]]:
    if path.suffix.lower() == ".xlsx":
        return read_xlsx(path)
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def validate(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    """Returns the usable rows (skips `skip` notes) or raises on any invalid one."""
    kept: list[dict[str, str]] = []
    seen: set[str] = set()
    for i, r in enumerate(rows, start=2):
        pid = (r.get("pair_id") or "").strip()
        if not pid:
            raise LabelImportError(f"row {i}: empty pair_id")
        if pid in seen:
            raise LabelImportError(f"row {i}: duplicate pair_id {pid}")
        seen.add(pid)
        if "skip" in (r.get("notes") or "").lower():
            continue
        label = (r.get("human_label") or "").strip().lower()
        if label not in VALID_LABELS:
            raise LabelImportError(
                f"row {i} ({pid}): human_label {label!r} is not one of {VALID_LABELS}"
            )
        if len(pid.split(":")) != 4 or pid.split(":")[0] not in SOURCE_DIRS:
            raise LabelImportError(f"row {i}: unrecognised pair_id {pid!r}")
        kept.append({**r, "human_label": label})
    return kept


def _copy_unique(src: Path, dst: Path) -> None:
    if dst.exists() and dst.read_bytes() != src.read_bytes():
        raise LabelImportError(f"two different files would both be named {dst.name}")
    shutil.copyfile(src, dst)


def write_dataset(rows: list[dict[str, str]], out: Path) -> dict[str, int]:
    (out / "resumes").mkdir(parents=True, exist_ok=True)
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    counts = {"test": 0, "tune": 0}
    with open(out / "labels.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["resume", "job", "expected", "reason", "split", "source", "auto_label"])
        for r in rows:
            dataset, split, resume, job = r["pair_id"].split(":")
            src = SOURCE_DIRS[dataset]
            _copy_unique(src / "resumes" / resume, out / "resumes" / resume)
            _copy_unique(src / "jobs" / job, out / "jobs" / job)
            held_out = "test" if dataset == "kaggle_domain" and split == "test" else "tune"
            counts[held_out] += 1
            w.writerow([resume, job, r["human_label"], (r.get("notes") or "").strip(), held_out,
                        dataset, (r.get("auto_label") or "").strip()])
    return counts


def main() -> None:
    p = argparse.ArgumentParser(description="Import hand-labeled hard pairs as an eval dataset")
    p.add_argument("--sheet", default="ml/eval/labeling/hard_pairs_labeled.xlsx")
    p.add_argument("--out", default="ml/eval/datasets/human_hard")
    args = p.parse_args()
    rows = validate(read_sheet(Path(args.sheet)))
    counts = write_dataset(rows, Path(args.out))
    print(
        f"Imported {len(rows)} labeled pairs into {args.out} "
        f"({counts['test']} test, {counts['tune']} tune)"
    )


if __name__ == "__main__":
    main()
