"""
Builds the `real_fit` eval set: real, long job postings with several labeled resumes each.

Source: the public "resume / job description fit" pairs (two parquet files, train + test; each
row is "For the given job description <<JD>> the resume: <<resume>>. The result is, <label>",
with the label Good Fit / Potential Fit / No Fit). Optionally the Kaggle "Resume Dataset" PDFs:
a resume that also exists there is written as its original PDF for about half of its pairs,
so the parser path is exercised too.

Labels come from the source and are mapped Good -> strong, Potential -> medium, No -> weak.
Nothing is labeled here. The label provenance of the source is not verified, so the README
says so.

Selection (see ml/eval/datasets/README.md, "What the next labeled dataset should look like"):
  - JDs of 250-1000 words with at least two label kinds among their resumes (three preferred)
  - jobs chosen round-robin across fields so no field dominates
  - up to 5 resumes per job, balanced across labels
  - split by job: source-test jobs -> test, source-train jobs -> tune; resumes used in test
    are removed from tune, so no person is in both
  - emails, phone numbers and URLs scrubbed

The texts are third-party data with unclear licenses, so the output goes to a gitignored folder.
Only manifest.csv (ids, hashes, labels, splits) and this script are committed.

Usage (needs pyarrow, e.g. in a throwaway python:3.11 container):
    python -m ml.eval.build_real_fit_dataset --train train.parquet --test test.parquet \
        [--kaggle-zip resumes-data.zip] [--out ml/eval/datasets_local/real_fit]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

LABEL_MAP = {"Good Fit": "strong", "Potential Fit": "medium", "No Fit": "weak"}
PAIR_RE = re.compile(
    r"For the given job description <<(.*)>> the resume: <<(.*)>>\. The result is, (.*)$", re.S
)
MIN_JD_WORDS, MAX_JD_WORDS = 250, 1000
MAX_RESUMES_PER_JOB = 5
TARGET_JOBS = {"test": 25, "tune": 35}

# Ordered: the first field whose words appear most in the JD wins. Used only to spread jobs
# across fields; it is never a label.
FIELDS: dict[str, tuple[str, ...]] = {
    "software": ("software", "developer", "java", "python", "javascript", "devops", "cloud",
                 "backend", "frontend", "full stack", "api", "kubernetes"),
    "data": ("data analyst", "data scien", "machine learning", "analytics", "sql", "tableau",
             "power bi", "statistic", "etl", "data engineer"),
    "finance_accounting": ("accountant", "accounting", "financial", "audit", "tax", "ledger",
                           "bookkeep", "payroll", "budget", "cpa"),
    "healthcare": ("patient", "nurse", "clinical", "medical", "health", "hospital", "pharma"),
    "sales_marketing": ("sales", "marketing", "customer", "account executive", "brand",
                        "campaign", "retail", "business development"),
    "engineering_manufacturing": ("mechanical", "electrical", "manufacturing", "maintenance",
                                  "plant", "production", "engineer", "quality", "cad"),
    "hr_admin": ("human resources", "recruit", "hr ", "administrative", "office manager",
                 "payroll", "onboarding"),
    "legal_education_other": ("legal", "attorney", "paralegal", "teacher", "teaching",
                              "curriculum", "construction", "logistics", "supply chain"),
}

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_PHONE = re.compile(r"(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}")
_URL = re.compile(r"(?:https?://|www\.)\S+", re.I)


def scrub(text: str) -> str:
    """Removes contact details; keeps everything else as written."""
    return _URL.sub("[url]", _PHONE.sub("[phone]", _EMAIL.sub("[email]", text)))


def short_hash(text: str) -> str:
    return hashlib.sha256(" ".join(text.split()).encode("utf-8")).hexdigest()[:12]


def field_of(jd: str) -> str:
    t = jd.lower()
    scores = {f: sum(t.count(w) for w in words) for f, words in FIELDS.items()}
    best = max(scores, key=lambda f: scores[f])
    return best if scores[best] > 0 else "legal_education_other"


def read_parquet_rows(path: Path) -> list[dict[str, str]]:
    import pyarrow.parquet as pq  # only needed to build, not to evaluate

    rows = pq.read_table(path).to_pylist()
    return [{"text": str(r["text"]), "label": str(r["label"])} for r in rows]


def parse_pairs(rows: list[dict[str, str]], source_split: str) -> list[dict[str, str]]:
    out = []
    for r in rows:
        m = PAIR_RE.match(r["text"])
        if m and r["label"] in LABEL_MAP:
            jd, resume = m.group(1).strip(), m.group(2).strip()
            out.append({"jd": jd, "resume": resume, "label": LABEL_MAP[r["label"]],
                        "source_split": source_split, "jd_id": short_hash(jd),
                        "resume_id": short_hash(resume)})
    return out


def _letters(text: str) -> str:
    return re.sub(r"[^a-z]", "", text.lower())


def kaggle_pdf_index(zip_path: Path) -> dict[str, tuple[str, bytes]]:
    """Maps a resume fingerprint to (kaggle id, original PDF bytes) for resumes in the zip."""
    csv.field_size_limit(10**8)
    out: dict[str, tuple[str, bytes]] = {}
    with zipfile.ZipFile(zip_path) as zf:
        pdfs = {Path(n).stem: n for n in zf.namelist() if n.lower().endswith(".pdf")}
        text = zf.read("Resume/Resume.csv").decode("utf-8", errors="replace")
        for row in csv.DictReader(io.StringIO(text)):
            if row["ID"] in pdfs:
                out[_letters(row["Resume_str"])] = (row["ID"], zf.read(pdfs[row["ID"]]))
    return out


def match_pdf(resume: str, index: dict[str, tuple[str, bytes]]) -> tuple[str, bytes] | None:
    nr = _letters(resume)
    probes = [nr[i : i + 60] for i in (300, 800, 1500) if len(nr) > i + 60]
    if not probes:
        return None
    for kt, hit in index.items():
        if sum(p in kt for p in probes) >= max(1, len(probes) - 1):
            return hit
    return None


def select(
    pairs: list[dict[str, str]], split: str, banned_resumes: set[str]
) -> list[dict[str, str]]:
    by_job: dict[str, list[dict[str, str]]] = defaultdict(list)
    for p in pairs:
        if p["resume_id"] not in banned_resumes:
            by_job[p["jd_id"]].append(p)
    candidates = []
    for jid, ps in by_job.items():
        words = len(ps[0]["jd"].split())
        kinds = {p["label"] for p in ps}
        if MIN_JD_WORDS <= words <= MAX_JD_WORDS and len(kinds) >= 2:
            candidates.append((-len(kinds), jid, field_of(ps[0]["jd"])))
    candidates.sort()  # all-three-label jobs first, then by stable id
    queues: dict[str, list[str]] = defaultdict(list)
    for _, jid, f in candidates:
        queues[f].append(jid)
    chosen: list[str] = []
    while len(chosen) < TARGET_JOBS[split] and any(queues.values()):
        for f in sorted(queues):  # round-robin across fields
            if queues[f] and len(chosen) < TARGET_JOBS[split]:
                chosen.append(queues[f].pop(0))
    out: list[dict[str, str]] = []
    for jid in chosen:
        ps = sorted(by_job[jid], key=lambda p: p["resume_id"])
        per_label: dict[str, list[dict[str, str]]] = defaultdict(list)
        for p in ps:
            per_label[p["label"]].append(p)
        picked: list[dict[str, str]] = []
        while len(picked) < MAX_RESUMES_PER_JOB and any(per_label.values()):
            for lab in ("strong", "medium", "weak"):
                if per_label[lab] and len(picked) < MAX_RESUMES_PER_JOB:
                    picked.append(per_label[lab].pop(0))
        out.extend({**p, "split": split, "field": field_of(p["jd"])} for p in picked)
    return out


def build(train: Path, test: Path, kaggle_zip: Path | None, out: Path) -> dict[str, object]:
    test_pairs = select(parse_pairs(read_parquet_rows(test), "test"), "test", set())
    used_in_test = {p["resume_id"] for p in test_pairs}
    tune_pairs = select(parse_pairs(read_parquet_rows(train), "train"), "tune", used_in_test)
    pairs = test_pairs + tune_pairs

    pdf_index = kaggle_pdf_index(kaggle_zip) if kaggle_zip else {}
    (out / "resumes").mkdir(parents=True, exist_ok=True)
    (out / "jobs").mkdir(parents=True, exist_ok=True)
    rows = []
    pdf_turn: Counter[str] = Counter()
    for p in pairs:
        job_file = f"job_{p['jd_id']}.txt"
        (out / "jobs" / job_file).write_text(scrub(p["jd"]), encoding="utf-8")
        resume_file = f"resume_{p['resume_id']}.txt"
        hit = match_pdf(p["resume"], pdf_index) if pdf_index else None
        pdf_turn[p["resume_id"]] += 1
        if hit and pdf_turn[p["resume_id"]] % 2 == 1:  # alternate PDF and text for this resume
            resume_file = f"resume_{p['resume_id']}_kaggle{hit[0]}.pdf"
            (out / "resumes" / resume_file).write_bytes(hit[1])
        else:
            (out / "resumes" / resume_file).write_text(scrub(p["resume"]), encoding="utf-8")
        rows.append({
            "resume": resume_file, "job": job_file, "expected": p["label"],
            "reason": (
                f"source label ({p['label']}) from the resume/JD fit dataset, "
                "not human-verified here"
            ),
            "split": p["split"],
            "source": f"resume_jd_fit:{p['source_split']}",
            "field": p["field"],
            "jd_words": str(len(p["jd"].split())), "resume_words": str(len(p["resume"].split())),
        })
    with open(out / "labels.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    return {
        "pairs": len(rows),
        "jobs": len({r["job"] for r in rows}),
        "by_split": dict(Counter(r["split"] for r in rows)),
        "by_label": dict(Counter(r["expected"] for r in rows)),
        "by_field": dict(Counter(r["field"] for r in rows)),
        "pdf_resumes": sum(r["resume"].endswith(".pdf") for r in rows),
    }


def main() -> None:
    p = argparse.ArgumentParser(description="Build the real_fit eval set from the fit parquets")
    p.add_argument("--train", required=True)
    p.add_argument("--test", required=True)
    p.add_argument("--kaggle-zip", default=None)
    p.add_argument("--out", default="ml/eval/datasets_local/real_fit")
    a = p.parse_args()
    kaggle = Path(a.kaggle_zip) if a.kaggle_zip else None
    stats = build(Path(a.train), Path(a.test), kaggle, Path(a.out))
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
