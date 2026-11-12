"""Build `ml/data/domain_knowledge_v1.json` from the O*NET 31.0 text database.

O*NET is published by the U.S. Department of Labor, Employment and Training Administration, under
CC BY 4.0 (https://www.onetcenter.org/database.html). The file keeps only what the engine uses for
five domains: occupation titles and alternate titles, typical education and experience, related
occupations, common software and tools, and core tasks.

    python -m ml.evalkit.build_domain_knowledge --src <dir with db_31_0_text files>
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path

from ml.scoring.units import DATA

DOMAINS = {
    "software_it": ("15-1", "15-2051", "11-3021"),
    "healthcare": ("29-", "31-", "11-9111"),
    "skilled_trades": ("47-", "49-", "51-"),
    "accounting_finance": ("13-2", "43-3", "11-3031"),
    "legal": ("23-", "13-1041", "43-6012"),
}
EDU_TO_LADDER = {1: 0, 2: 0, 3: 1, 4: 1, 5: 2, 6: 3, 7: 3, 8: 4, 9: 4, 10: 5, 11: 5, 12: 5}
RW_YEARS = {1: 0.0, 2: 0.04, 3: 0.15, 4: 0.375, 5: 0.75, 6: 1.5, 7: 3.0, 8: 5.0, 9: 7.0, 10: 9.0, 11: 12.0}
SOURCE = {
    "name": "O*NET 31.0 Database",
    "publisher": "U.S. Department of Labor, Employment and Training Administration",
    "license": "CC BY 4.0",
    "url": "https://www.onetcenter.org/database.html",
}


def domain_of(code: str) -> str | None:
    for name, prefixes in DOMAINS.items():
        if any(code.startswith(p) for p in prefixes):
            return name
    return None


def rows(path: Path):
    with path.open(encoding="utf-8", newline="") as fh:
        yield from csv.DictReader(fh, delimiter="\t")


def build(src: Path) -> dict:
    occ: dict[str, dict] = {}
    for r in rows(src / "Occupation Data.txt"):
        code = r["O*NET-SOC Code"]
        dom = domain_of(code)
        if dom:
            occ[code] = {"soc": code, "title": r["Title"], "domain": dom, "alt_titles": [],
                         "tools": [], "tasks": [], "related": []}
    titles: dict[str, set[str]] = defaultdict(set)
    for fname, col in (("Job Titles.txt", "Job Title"), ("Sample of Reported Titles.txt", "Reported Job Title")):
        for r in rows(src / fname):
            code = r["O*NET-SOC Code"]
            if code in occ and r[col].strip():
                titles[code].add(r[col].strip())
    for code, ts in titles.items():
        occ[code]["alt_titles"] = sorted(ts, key=lambda t: (len(t), t))[:150]
    tools: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for r in rows(src / "Software Skills.txt"):
        code = r["O*NET-SOC Code"]
        if code in occ:
            rank = (0 if r["Hot Technology"] == "Y" else 1) + (0 if r["In Demand"] == "Y" else 1)
            tools[code].append((rank, r["Workplace Example"].strip()))
    for code, items in tools.items():
        seen: list[str] = []
        for _, name in sorted(items):
            if name and name not in seen:
                seen.append(name)
        occ[code]["tools"] = seen[:40]
    for r in rows(src / "Task Statements.txt"):
        code = r["O*NET-SOC Code"]
        if code in occ and r["Task Type"] == "Core" and len(occ[code]["tasks"]) < 12:
            occ[code]["tasks"].append(r["Task"].strip()[:170])
    for r in rows(src / "Job Zones.txt"):
        if r["O*NET-SOC Code"] in occ:
            occ[r["O*NET-SOC Code"]]["job_zone"] = int(r["Job Zone"])
    edu: dict[str, dict[int, float]] = defaultdict(dict)
    exp: dict[str, dict[int, float]] = defaultdict(dict)
    for r in rows(src / "Education.txt"):
        if r["Scale ID"] == "RL" and r["O*NET-SOC Code"] in occ and r["Data Value"] != "n/a":
            edu[r["O*NET-SOC Code"]][int(r["Category"])] = float(r["Data Value"])
    for r in rows(src / "Training and Experience.txt"):
        if r["Scale ID"] == "RW" and r["O*NET-SOC Code"] in occ and r["Data Value"] != "n/a":
            exp[r["O*NET-SOC Code"]][int(r["Category"])] = float(r["Data Value"])
    for code, cats in edu.items():
        top = max(cats, key=cats.get)
        occ[code]["typical_education_level"] = EDU_TO_LADDER[top]
    for code, cats in exp.items():
        total = sum(cats.values()) or 1.0
        occ[code]["typical_years"] = round(sum(RW_YEARS[c] * v for c, v in cats.items()) / total, 1)
    rel: dict[str, list[tuple[int, str]]] = defaultdict(list)
    order = {"Primary-Short": 0, "Primary-Long": 1, "Supplemental": 2}
    for r in rows(src / "Related Occupations.txt"):
        if r["O*NET-SOC Code"] in occ and r["Relatedness Tier"] in order:
            rel[r["O*NET-SOC Code"]].append((order[r["Relatedness Tier"]] * 100 + int(r["Index"]),
                                              r["Related O*NET-SOC Code"]))
    for code, items in rel.items():
        occ[code]["related"] = [c for _, c in sorted(items)][:12]
    return {
        "schema_version": "domain-knowledge-v1",
        "source": SOURCE,
        "domains": {d: list(p) for d, p in DOMAINS.items()},
        "occupations": [occ[c] for c in sorted(occ)],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default=str(DATA / "domain_knowledge_v1.json"))
    args = ap.parse_args()
    data = build(Path(args.src))
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    by = {d: sum(1 for o in data["occupations"] if o["domain"] == d) for d in DOMAINS}
    print(f"wrote {args.out}: {len(data['occupations'])} occupations {by}")


if __name__ == "__main__":
    main()
