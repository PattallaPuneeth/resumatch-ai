"""Role family tests (tiny strings): O*NET title matching, relations, resume role discovery."""

from datetime import date

import pytest
from ml.scoring import roles as R

D = date(2026, 11, 12)
pytestmark = pytest.mark.skipif(not R.knowledge()[0], reason="domain knowledge file not built")


@pytest.mark.parametrize(
    ("title", "occupation"),
    [
        ("Senior Software Engineer", "Software Developers"),
        ("Registered Nurse", "Registered Nurses"),
        ("Electrician", "Electricians"),
        ("Staff Accountant", "Accountants and Auditors"),
        ("Paralegal", "Paralegals and Legal Assistants"),
        ("Attorney", "Lawyers"),
        ("Bookkeeper", "Bookkeeping, Accounting, and Auditing Clerks"),
    ],
)
def test_titles_map_to_the_right_occupation_across_domains(title, occupation):
    assert R.match_title(title, top=1)[0].occupation == occupation


def test_seniority_words_do_not_change_the_occupation():
    a = R.match_title("Senior Staff Accountant", top=1)[0].soc
    b = R.match_title("Junior Accountant", top=1)[0].soc
    assert a == b


def test_unknown_or_empty_titles_give_no_match():
    assert R.match_title("", top=1) == [] and R.match_title("zzzz qqqq", top=1) == []


def test_relations_cover_all_four_levels():
    soc = lambda t: R.match_title(t, top=1)[0].soc  # noqa: E731
    assert R.relation(soc("Staff Accountant"), soc("Corporate Accountant")) == "same role"
    assert R.relation(soc("Software Developer"), soc("Quality Assurance Tester")) == "related role"
    assert R.relation(soc("Electrician"), soc("Welder")) in {"related role", "same field"}
    assert R.relation(soc("Staff Accountant"), soc("Electrician")) == "different field"


def test_role_fit_reads_titles_next_to_dates_and_the_headline():
    resume = (
        "ALEX CHEN, Lead SDET\n### EXPERIENCE\n**Software Test Engineer | Acme | Austin**\n"
        "*January 2021 - Present*\n- Built suites\n"
    )
    fit = R.role_fit("Job Title: Software Developer\n- Java", resume, D)
    assert fit["relation"] in {"related role", "same role"}
    assert fit["jd_role"]["occupation"] == "Software Developers" and fit["note"]
    assert "O*NET" in fit["source"]


def test_different_field_is_explained_not_blamed():
    resume = "Experience\nElectrician, 2015 - 2024, Acme Electric\n"
    fit = R.role_fit("Job Title: Staff Accountant\n- GAAP", resume, D)
    assert fit["relation"] == "different field"
    assert "different field" in fit["note"] and "fail" not in fit["note"].lower()


def test_tied_job_occupations_use_the_closest_relation():
    resume = "Experience\nStaff Accountant, 2015 - 2024, Acme\n"
    fit = R.role_fit("Job Title: Senior Cost Accountant\n- Costing", resume, D)
    assert fit["relation"] in {"same role", "related role"}


def test_unrecognised_job_title_says_so():
    fit = R.role_fit("Job Title: Zzqq Wxyv\n- thing", "Experience\nNurse 2015-2024", D)
    assert fit["relation"] == "unknown" and "not recognised" in fit["note"]
