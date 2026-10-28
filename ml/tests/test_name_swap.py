"""Name-swap bias test helpers: name filling and the spread summary."""

from __future__ import annotations

from pathlib import Path

from ml.eval.name_swap import TEST_NAMES, build_variants, summarize, with_name


def test_with_name_fills_placeholders_or_adds_a_line() -> None:
    assert with_name("[name] [name]\nSales lead", "Ayesha Khan") == "Ayesha Khan\nSales lead"
    assert with_name("Contact [name] at Acme", "Wei Chen") == "Contact Wei at Acme"
    assert with_name("Sales lead", "Wei Chen") == "Wei Chen\nSales lead"


def test_build_variants_writes_one_copy_per_name(tmp_path: Path) -> None:
    src = tmp_path / "src"
    (src / "resumes").mkdir(parents=True)
    (src / "jobs").mkdir()
    (src / "resumes" / "r1.txt").write_text("[name] [name]\nPython developer", encoding="utf-8")
    (src / "jobs" / "j1.txt").write_text("Job Title: Python Developer", encoding="utf-8")
    (src / "labels.csv").write_text("resume,job,expected,reason,split\nr1.txt,j1.txt,strong,x,test\n",
                                    encoding="utf-8")
    variants = build_variants(src, tmp_path / "out", n_pairs=5, split="test")
    assert len(variants) == len(TEST_NAMES)
    texts = {(tmp_path / "out" / "resumes" / v["resume"]).read_text(encoding="utf-8")
             for v in variants}
    assert len(texts) == len(TEST_NAMES)  # each copy differs only by the name
    assert all(t.endswith("\nPython developer") for t in texts)


def test_summarize_reports_spread_and_band_flips() -> None:
    variants = [{"resume": f"v{k}", "pair": "0", "name": n, "gender": g, "origin": o}
                for k, (n, g, o) in enumerate(TEST_NAMES)]
    scores = {f"v{k}": 70.0 + (6.0 if k == 0 else 0.0) for k in range(len(TEST_NAMES))}
    report = summarize(variants, scores)
    assert report["max_spread"] == 6.0
    assert report["pairs_whose_band_changes"] == 1  # 76 is strong, 70 is medium
