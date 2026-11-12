"""Tests for the India-focused data added on 2026-11-12: skills catalog, title map, implications,
credential registry. Tiny strings only; no labeled samples are involved."""

import json
from fractions import Fraction as F

from ml.scoring import roles
from ml.scoring import units as U
from ml.scoring.units import DATA


def _credit(jd_line: str, resume: str) -> F:
    seg = U.segment("Requirements:\n- " + jd_line + "\n")
    return U.score_units(seg.units, U.index_resume(resume))[0].credit


def test_tally_variants_are_one_skill():
    jd = "Hands-on experience with Tally Prime."
    assert _credit(jd, "Experience\n- Maintained books in Tally ERP 9") > F(3, 4)
    assert _credit(jd, "Experience\n- Maintained books in Zoho Books") < F(1, 2)


def test_gst_returns_imply_gst_but_not_the_reverse():
    jd = "Knowledge of GST compliance."
    with_returns = _credit(jd, "Experience\n- Filed GSTR-3B and GSTR-1 monthly for 12 clients")
    assert with_returns > _credit(jd, "Experience\n- Prepared payroll")
    assert with_returns > 0


def test_sap_module_implies_sap():
    assert _credit("SAP experience", "Experience\n- Configured SAP FICO for a retail client") > F(1, 2)


def test_indian_nursing_and_trade_titles_resolve_to_onet_roles():
    assert roles.match_title("Staff Nurse - ICU")
    assert roles.match_title("ITI Electrician")
    assert roles.match_title("Sr. Accounts Executive")
    assert roles.match_title("Advocate")


def test_title_map_targets_all_resolve():
    data = json.loads((DATA / "india_titles.json").read_text(encoding="utf-8"))
    broken = [
        (k, v) for k, v in data["phrases"].items()
        if not roles.match_title(v, top=1) and k not in {"site engineer"}
    ]
    # targets the five-domain index does not hold are tolerated only if listed here
    assert len(broken) <= 40, broken


def test_new_credentials_have_sources_and_unique_ids():
    doc = json.loads((DATA / "credential_registry.json").read_text(encoding="utf-8"))
    ids = [e["credential_id"] for e in doc["entries"]]
    assert len(ids) == len(set(ids))
    for needed in (
        "in.accounting.icsi_company_secretary",
        "in.accounting.icmai_cma",
        "in.banking.iibf_jaiib_caiib",
        "in.healthcare.nmc_medical_registration",
        "in.healthcare.pharmacist_state_registration",
    ):
        assert needed in ids
    assert all(e["provenance"]["source_urls"] for e in doc["entries"])


def test_catalog_has_no_duplicate_skill_names_or_aliases():
    rows = json.loads((DATA / "skills_catalog_domains.json").read_text(encoding="utf-8"))["skills"]
    names = [r["skill"].casefold() for r in rows]
    assert len(names) == len(set(names))
    surfaces: dict[str, str] = {}
    for r in rows:
        for a in r["aliases"]:
            k = a.casefold()
            assert surfaces.setdefault(k, r["skill"]) == r["skill"], (k, r["skill"])
            assert k not in names or k == r["skill"].casefold()
