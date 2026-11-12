"""Mechanics tests (not accuracy samples): segmentation, coverage arithmetic, curve and metrics."""

import json
from fractions import Fraction as F

import pytest
from ml.evalkit import metrics12 as M
from ml.scoring import curve as C
from ml.scoring import units as U

JD = (
    "Senior Accountant\n"
    "About us: We are a friendly company.\n"
    "Responsibilities:\n"
    "- Prepare month-end close and general ledger reconciliations\n"
    "Requirements:\n"
    "- Proficiency in SAP and Excel is required\n"
    "- CPA preferred\n"
    "Benefits: health insurance\n"
)


def test_idf_table_is_frozen_and_verified():
    t = U.load_idf()
    assert t.loaded and t.n_docs >= 50
    assert t.idf("zzzunseenterm") == t.idf("zzzunseenterm2")  # unseen terms weigh like df=1
    assert 1.0 <= min(t.idf(x) for x in list(t.df)[:50])


def test_segments_keep_requirements_drop_boilerplate_and_spans_are_exact():
    seg = U.segment(JD)
    texts = [u.text for u in seg.units]
    assert any("general ledger" in x for x in texts)
    assert not any("friendly company" in x or "health insurance" in x for x in texts)
    for u in seg.units:
        assert seg.text[u.start : u.end] == u.text
    cues = {u.text: u.cue for u in seg.units}
    assert [c for t, c in cues.items() if "SAP" in t] == ["Required"]


def test_markdown_headings_and_metadata_lines():
    jd = (
        "**Job Title:** Cost Accountant\n**Location:** Allentown, PA\n**Salary:** $90,000\n\n"
        "### REQUIRED SKILLS:\n\n* Standard costing and variance analysis.\n\n"
        "### Preferred Qualifications\n\n* Experience with SAP.\n"
    )
    seg = U.segment(jd)
    texts = {u.text: u.cue for u in seg.units}
    assert texts["Cost Accountant"] == "Unlabelled"
    assert not any("Allentown" in x or "90,000" in x for x in texts)  # confirm-only, never units
    assert texts["Standard costing and variance analysis."] == "Required"
    assert texts["Experience with SAP."] == "Preferred"
    for u in seg.units:
        assert seg.text[u.start : u.end] == u.text


def test_competencies_heading_counts_as_a_skills_list():
    idx = U.index_resume("### CORE COMPETENCIES\n* Selenium, TestNG\n### EXPERIENCE\n* Built suites")
    hit = U._find_hit(idx, "seleniu")
    assert hit is not None and hit.context == "skills_list"


def test_preferred_cue_and_cap_of_25_units():
    seg = U.segment("Requirements:\n- CPA is preferred and valued highly\n")
    assert seg.units and seg.units[0].cue == "Preferred"
    many = "Requirements:\n" + "\n".join(f"- Experience with tool{i} and system{i} platform" for i in range(40))
    seg = U.segment(many)
    assert len(seg.units) == U.MAX_UNITS and seg.not_evaluated == 15


def test_alias_spans_use_original_spelling_and_context():
    idx = U.index_resume("Experience\n- Deployed services on k8s\nSkills\nExcel")
    hit = U._find_hit(idx, "kubernetes")
    assert hit is not None and hit.quote == "k8s" and hit.context == "experience"
    assert idx.text[hit.start : hit.end] == "k8s"
    excel = U._find_hit(idx, "excel")
    assert excel is not None and excel.context == "skills_list" and excel.mult == 0.8


def test_negated_mention_earns_no_credit():
    idx = U.index_resume("Experience\n- I have no experience with Kubernetes at all")
    seg = U.segment("Requirements:\n- Kubernetes and Docker experience required\n")
    res = U.score_units(seg.units, idx)
    assert res[0].credit == 0


def test_coverage_is_exact_and_deterministic():
    seg = U.segment(JD)
    idx = U.index_resume("Experience\nPrepared month-end close and general ledger work using SAP and Excel.")
    a, b = U.score_units(seg.units, idx), U.score_units(seg.units, idx)
    assert [r.credit for r in a] == [r.credit for r in b]
    assert 0 < U.coverage(a) <= 1
    assert U.coverage(U.score_units(seg.units, U.index_resume("Plumber and welder."))) < F(1, 10)


def test_stuffing_guard_halves_list_only_credit():
    jd = "Requirements:\n" + "\n".join(f"- Mastery of skill{i}x tool{i}y required" for i in range(6))
    resume = "Skills\n" + ", ".join(f"skill{i}x tool{i}y" for i in range(6))
    seg = U.segment(jd)
    res = U.score_units(seg.units, U.index_resume(resume))
    assert all(r.credit <= F(1, 2) for r in res if r.hits)


def test_curve_validation_and_interpolation():
    c = C.from_dict({"version": "t", "fitted": True, "knots": [["0", "0"], ["1/5", "1/2"], ["1", "1"]]})
    assert c(F(0)) == 0 and c(F(1, 10)) == F(1, 4) and c(F(1)) == 1 and c(F(2)) == 1
    for bad in (
        [["0", "0"], ["1", "1/2"]],  # does not end at (1,1)
        [["0", "0"], ["1/2", "1"], ["3/4", "1/2"], ["1", "1"]],  # decreasing
        [["0", "0"], ["1/10", "9/10"], ["1", "1"]],  # slope 9 > 6
    ):
        with pytest.raises(ValueError):
            C.from_dict({"version": "t", "fitted": True, "knots": bad})


def test_shipped_curve_is_valid_and_flagged_unfitted():
    c = C.load()
    assert c.fitted is False and "placeholder" in c.version


def test_isotonic_and_fit_are_monotone():
    assert C.isotonic([3, 1, 2, 4]) == [2.0, 2.0, 2.0, 4.0]
    pairs = [(i / 100, 0 if i < 30 else 1 if i < 60 else 2) for i in range(100)]
    fitted = C.fit(pairs)
    ys = [fitted(F(i, 100)) for i in range(101)]
    assert ys == sorted(ys) and fitted.fitted
    with pytest.raises(ValueError):
        C.fit(pairs[:10])


def test_metrics_counts_ci_and_gate():
    truth = [0, 0, 1, 1, 2, 2, 0, 1, 2, 1]
    pred = [0, 1, 1, 1, 2, None, 0, 2, 0, 1]
    s = M.summarize(truth, pred, tiers=["Firm"] * 10, confidence=["High"] * 10)
    assert (s["correct"], s["wrong"], s["no_verdict"]) == (6, 3, 1)
    assert s["opposite_extreme_errors"] == pytest.approx(0.1)
    assert sum(sum(row) for row in s["confusion_rows_truth_cols_no_pot_good_none"]) == 10
    lo, hi = s["accuracy_ci95"]
    assert lo <= s["accuracy"] <= hi
    assert M.bootstrap_ci([True] * 20) == (1.0, 1.0)
    assert not all(M.passes_gate(s).values())


def test_split_is_stable_by_job():
    assert M.assign_split("job-a") == M.assign_split("job-a")
    share = sum(M.assign_split(f"job-{i}") == "test" for i in range(1000)) / 1000
    assert 0.33 < share < 0.47


def test_small_sets_split_by_job_near_sixty_forty():
    keys = [f"job{i % 12}" for i in range(47)]  # 12 jobs, 47 pairs
    a, b = M.assign_splits(keys), M.assign_splits(keys)
    assert a == b  # stable
    by_job = {}
    for k, sp in zip(keys, a, strict=True):
        by_job.setdefault(k, set()).add(sp)
    assert all(len(v) == 1 for v in by_job.values())  # no job in both splits
    test_share = a.count("test") / len(a)
    assert 0.3 <= test_share <= 0.55 and "tune" in a
    assert M.assign_splits(["only-job"] * 5) == ["tune"] * 5  # one job cannot be split


def test_labels_accept_both_vocabularies():
    assert [M.label_to_int(x) for x in ("No Fit", "weak", "Potential Fit", "medium", "Good Fit", "strong")] == [0, 0, 1, 1, 2, 2]
    with pytest.raises(ValueError):
        M.label_to_int("maybe")


def test_harness_locks_the_test_split(tmp_path, monkeypatch):
    from ml.evalkit import item12_eval as H

    monkeypatch.setattr(H, "OUT_DIR", tmp_path)
    monkeypatch.setattr(H, "LOCK_LOG", tmp_path / "lock.json")
    rows = [
        {"resume_text": f"Plumber number {i}", "job_description_text": f"Requirements:\n- Welding tools number {i} required",
         "label": "No Fit", "split": "test"}
        for i in range(3)
    ]
    path = tmp_path / "pairs.csv"
    import csv

    with path.open("w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    assert H.main(["evaluate", "--input", str(path), "--split", "test", "--final"]) == 0
    assert json.loads((tmp_path / "lock.json").read_text())[0]["n"] == 3
    with pytest.raises(SystemExit):
        H.main(["evaluate", "--input", str(path), "--split", "test", "--final"])
    with pytest.raises(SystemExit):
        H.main(["evaluate", "--input", str(path), "--split", "tune", "--final"])
