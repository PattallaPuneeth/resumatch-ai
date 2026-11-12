"""Evaluation harness for the Item 1/2 engine (design E0).

Input: a CSV (or XLSX) with columns resume_text, job_description_text, label
(No Fit / Potential Fit / Good Fit, or weak / medium / strong). Optional columns: pair_id,
job_id, split (tune / test). Without a split column, pairs are split by job with a stable hash.

    python -m ml.evalkit.item12_eval evaluate --input pairs.csv --split tune
    python -m ml.evalkit.item12_eval fit-curve --input pairs.csv [--install]
    python -m ml.evalkit.item12_eval evaluate --input pairs.csv --split test --final

`--final` is the locked test: it runs the test split once per (input file, engine digest).
A second run on the same pair is refused unless --allow-repeat, and every run is logged.
No sample data ships with the repo; samples come only from the owner.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from ml.evalkit import metrics12 as M

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / "eval-output" / "item12"
LOCK_LOG = OUT_DIR / "locked_test_log.json"
AS_OF = date(2026, 11, 12)  # fixed so results never depend on the day the harness runs
ENGINE_FILES = [
    *sorted((ROOT / "ml" / "scoring").glob("*.py")),
    ROOT / "ml" / "data" / "jd_idf_v1.json",
    ROOT / "ml" / "data" / "coverage_curve_v1.json",
    ROOT / "ml" / "data" / "skills_aliases.json",
    ROOT / "ml" / "data" / "skills_catalog_domains.json",
]


def engine_digest() -> str:
    h = hashlib.sha256()
    for f in ENGINE_FILES:
        if f.exists():
            h.update(f.name.encode())
            h.update(f.read_bytes())
    return h.hexdigest()


def load_rows(path: Path) -> list[dict]:
    if path.suffix.lower() == ".xlsx":
        try:
            import openpyxl
        except ImportError as exc:  # pragma: no cover
            raise SystemExit("reading .xlsx needs openpyxl; or save the sheet as CSV") from exc
        ws = openpyxl.load_workbook(path, read_only=True).active
        it = ws.iter_rows(values_only=True)
        head = [str(c).strip() if c is not None else "" for c in next(it)]
        rows = [dict(zip(head, ["" if c is None else str(c) for c in r], strict=False)) for r in it]
    else:
        csv.field_size_limit(10**8)
        with path.open(encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))
    need = {"resume_text", "job_description_text", "label"}
    if not rows or not need <= set(rows[0]):
        raise SystemExit(f"input needs columns {sorted(need)}; found {sorted(rows[0]) if rows else []}")
    for i, r in enumerate(rows):
        r["_y"] = M.label_to_int(r["label"])
        r["_job"] = r.get("job_id") or hashlib.sha256(r["job_description_text"].encode()).hexdigest()
        r["_id"] = r.get("pair_id") or str(i + 1)
        r["_split"] = (r.get("split") or "").strip().lower()
    unsplit = [r for r in rows if not r["_split"]]
    for r, sp in zip(unsplit, M.assign_splits([r["_job"] for r in unsplit]), strict=True):
        r["_split"] = sp
    return rows


def run_pairs(rows: list[dict], curve=None, matcher=None) -> list[dict]:
    from ml.scoring.pipeline_v31 import assess_pair

    out = []
    for r in rows:
        a = assess_pair(
            r["resume_text"], r["job_description_text"], as_of=AS_OF, curve=curve, matcher=matcher
        )
        out.append(a)
    return out


def make_llm_matcher(cap: int):
    """OpenRouter meaning matcher with a hard call cap; None when no key is configured."""
    from ml.scoring.llm_client import OpenRouterClient
    from ml.scoring.llm_match import MatchCache, make_matcher

    client = OpenRouterClient.from_env(cap=cap)
    if client is None:
        raise SystemExit("--llm needs OPENROUTER_API_KEY in the environment (.env is not read here)")
    return make_matcher(client, MatchCache(OUT_DIR / "llm_cache")), client


def summarize_run(rows: list[dict], results: list[dict]) -> dict:
    pred, ranges, tiers, conf = [], [], [], []
    for a in results:
        answered = a["tier"] in ("Firm", "Tentative") and a["verdict"] is not None
        pred.append(M.band_to_int(a["verdict"]) if answered else None)
        br = a.get("band_range")
        ranges.append((M.BANDS.index(br[0]), M.BANDS.index(br[1])) if br and answered else None)
        tiers.append(a["tier"])
        conf.append(a["confidence"])
    return M.summarize([r["_y"] for r in rows], pred, ranges, tiers, conf)


def write_pairs(path: Path, rows: list[dict], results: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["pair_id", "split", "label", "tier", "verdict", "score", "range", "confidence",
                    "raw_coverage"])
        for r, a in zip(rows, results, strict=True):
            cov = (a.get("coverage") or {}).get("raw_requirement_coverage")
            w.writerow([r["_id"], r["_split"], r["label"], a["tier"], a["verdict"], a["score"],
                        a["score_range"], a["confidence"], cov])


def cmd_evaluate(args: argparse.Namespace) -> int:
    rows = load_rows(Path(args.input))
    chosen = [r for r in rows if args.split == "all" or r["_split"] == args.split]
    if not chosen:
        raise SystemExit(f"no pairs in split {args.split!r}")
    digest, in_sha = engine_digest(), hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
    if args.final:
        if args.split != "test":
            raise SystemExit("--final only runs on --split test")
        log = json.loads(LOCK_LOG.read_text()) if LOCK_LOG.exists() else []
        if any(e["input_sha256"] == in_sha and e["engine_digest"] == digest for e in log) \
                and not args.allow_repeat:
            raise SystemExit("this test set was already scored with this exact engine; "
                             "change the engine or pass --allow-repeat (the repeat is logged)")
    matcher, client = (None, None)
    if args.llm:
        matcher, client = make_llm_matcher(args.llm_cap)
    results = run_pairs(chosen, matcher=matcher)
    summary = summarize_run(chosen, results)
    if client is not None:
        summary["llm_requests_used_total"] = client.budget.used()
        summary["llm_request_cap"] = client.budget.cap
    summary["gate"] = M.passes_gate(summary)
    summary["engine_digest"], summary["split"] = digest, args.split
    summary["curve_fitted"] = results[0]["engine"]["curve_fitted"] if results else None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{Path(args.input).stem}_{args.split}"
    write_pairs(OUT_DIR / f"{name}_pairs.csv", chosen, results)
    (OUT_DIR / f"{name}_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    if args.final:
        log = json.loads(LOCK_LOG.read_text()) if LOCK_LOG.exists() else []
        log.append({"at": datetime.now(timezone.utc).isoformat(), "input_sha256": in_sha,
                    "engine_digest": digest, "repeat": any(e["input_sha256"] == in_sha for e in log),
                    "accuracy": summary["accuracy"], "n": summary["n"]})
        LOCK_LOG.write_text(json.dumps(log, indent=2), encoding="utf-8")
    print_summary(summary)
    return 0


def print_summary(s: dict) -> None:
    lo, hi = s["accuracy_ci95"]
    print(f"n={s['n']}  correct={s['correct']}  wrong={s['wrong']}  no verdict={s['no_verdict']}")
    print(f"accuracy {s['accuracy']:.1%} (95% CI {lo:.1%}-{hi:.1%}); majority baseline "
          f"{s['majority_baseline']:.1%}")
    if s["accuracy_when_answered"] is not None:
        print(f"when it answers: {s['accuracy_when_answered']:.1%}; fit-vs-not {s['binary_fit_vs_not']:.1%}; "
              f"within one band {s['within_one_band']:.1%}; opposite-extreme errors "
              f"{s['opposite_extreme_errors']:.1%}")
    if "label_inside_band_range" in s:
        print(f"label inside the shown band range: {s['label_inside_band_range']:.1%}")
    print("rows = your label, cols = No Fit / Potential Fit / Good Fit / no verdict")
    for name, row in zip(M.BANDS, s["confusion_rows_truth_cols_no_pot_good_none"], strict=True):
        print(f"  {name:<14}" + "".join(f"{c:>8}" for c in row))
    for key in ("by_tier", "by_confidence"):
        if key in s:
            print(key, json.dumps(s[key]))
    if "llm_requests_used_total" in s:
        print(f"LLM requests used so far: {s['llm_requests_used_total']} of {s['llm_request_cap']}")
    print("gate:", json.dumps(s.get("gate", {})))
    if s.get("curve_fitted") is False:
        print("NOTE: the score curve is still the unfitted placeholder.")


def cmd_fit_curve(args: argparse.Namespace) -> int:
    from ml.scoring import curve as C

    rows = [r for r in load_rows(Path(args.input)) if r["_split"] == "tune"]
    if len(rows) < 100:
        raise SystemExit(f"fitting needs at least 100 tune pairs; found {len(rows)}")
    base = run_pairs(rows, curve=C.load())  # coverage does not depend on the curve
    cov = [float(a["coverage"]["raw_requirement_coverage"]) if a.get("coverage") else 0.0 for a in base]
    jobs = sorted({r["_job"] for r in rows})
    fold_of = {j: i % 5 for i, j in enumerate(jobs)}
    pred: list[tuple[int, int | None]] = []
    for fold in range(5):
        train = [(c, r["_y"]) for c, r in zip(cov, rows, strict=True) if fold_of[r["_job"]] != fold]
        test_rows = [(i, r) for i, r in enumerate(rows) if fold_of[r["_job"]] == fold]
        fitted = C.fit(train, version=f"cv{fold}")
        res = run_pairs([r for _, r in test_rows], curve=fitted)
        for (i, _), a in zip(test_rows, res, strict=True):
            pred.append((i, M.band_to_int(a["verdict"])))
    pred_sorted = [p for _, p in sorted(pred, key=lambda t: t[0])]
    cv = M.summarize([r["_y"] for r in rows], pred_sorted)
    placeholder = M.summarize([r["_y"] for r in rows],
                              [M.band_to_int(a["verdict"]) for a in base])
    print(f"tune pairs: {len(rows)}")
    print(f"placeholder curve: accuracy {placeholder['accuracy']:.1%} "
          f"(CI {placeholder['accuracy_ci95'][0]:.1%}-{placeholder['accuracy_ci95'][1]:.1%})")
    print(f"fitted, 5-fold by job: accuracy {cv['accuracy']:.1%} "
          f"(CI {cv['accuracy_ci95'][0]:.1%}-{cv['accuracy_ci95'][1]:.1%})")
    final = C.fit([(c, r["_y"]) for c, r in zip(cov, rows, strict=True)],
                  version=f"fitted-{date.today().isoformat()}-n{len(rows)}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    cand = OUT_DIR / "coverage_curve_candidate.json"
    cand.write_text(json.dumps(C.to_dict(final), indent=2), encoding="utf-8")
    print(f"candidate curve written to {cand}")
    if args.install:
        if cv["accuracy"] < placeholder["accuracy"]:
            raise SystemExit("not installed: the fitted curve is not better than the placeholder in CV")
        C.DEFAULT_PATH.write_text(json.dumps(C.to_dict(final), indent=2), encoding="utf-8")
        print(f"installed to {C.DEFAULT_PATH}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    ev = sub.add_parser("evaluate")
    ev.add_argument("--input", required=True)
    ev.add_argument("--split", choices=["tune", "test", "all"], default="tune")
    ev.add_argument("--final", action="store_true")
    ev.add_argument("--allow-repeat", action="store_true")
    ev.add_argument("--llm", action="store_true", help="add OpenRouter meaning matching (counted)")
    ev.add_argument("--llm-cap", type=int, default=300, help="hard cap on provider requests")
    ev.set_defaults(fn=cmd_evaluate)
    fc = sub.add_parser("fit-curve")
    fc.add_argument("--input", required=True)
    fc.add_argument("--install", action="store_true")
    fc.set_defaults(fn=cmd_fit_curve)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
