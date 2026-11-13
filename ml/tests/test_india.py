"""India-first wording: dates, degrees, titles, confirm-only lines (tiny strings, rules only)."""

from datetime import date

import pytest

from ml.scoring import roles as R
from ml.scoring import units as U
from ml.scoring.pipeline import _education_hits, assess_pair
from ml.scoring.spans import canonicalize

AS_OF = date(2026, 11, 12)


def test_indian_date_styles_become_one_style():
    text = "Apr'19 - Mar-22\nApr 2022 - till date\n01.04.2023 to 30.06.2023\nJun 2020 - ongoing"
    out = canonicalize(text)[0].split("\n")
    assert out[0] == "Apr 2019 - Mar 2022"
    assert out[1] == "Apr 2022 - Present"
    assert out[2] == "01/04/2023 to 30/06/2023"
    assert out[3] == "Jun 2020 - Present"
    assert canonicalize("Born 1999-05-14")[0] == "Born 1999-05-14"  # real ISO dates stay untouched


def test_years_are_counted_from_mixed_indian_formats():
    resume = (
        "Experience\nSoftware Engineer, TCS, Apr'19 - Mar'22 built Java services\n"
        "Sr. Software Engineer, Infosys, Apr'22 - till date built Java services\n"
    )
    r = assess_pair(resume, "Job Title: Software Engineer\nRequirements:\n- Java services\n- 3+ yrs experience\n",
                    as_of=AS_OF)
    assert r["years"]["source"] == "dated_relevant_roles" and float(r["years"]["candidate"]) > 7


@pytest.mark.parametrize(
    ("text", "level"),
    [("BTech in CSE", 3), ("B.E (Mechanical)", 3), ("MTech", 4), ("MSc Statistics", 4), ("LLB", 3),
     ("MBBS degree required", 3), ("B.Sc Nursing", 3), ("MBA", 4), ("PG Diploma in Management", 2)],
)
def test_indian_degree_wording(text, level):
    assert min(_education_hits(text)) == level


@pytest.mark.parametrize("text", ["MS Office and Excel", "Business Analyst (BA)", "MUST BE ABLE TO LEAD", "BE ready"])
def test_short_words_that_are_not_degrees(text):
    assert _education_hits(text) == []


def test_indian_confirm_only_lines_are_never_requirements():
    jd = (
        "Requirements:\n- Notice period: immediate joiners preferred\n- Work from office, rotational shift\n"
        "- Bond period of 2 years\n- Walk-in interview on Saturday\n- Tally and GST filing experience\n"
    )
    texts = " ".join(u.text for u in U.segment(jd).units)
    assert "Tally" in texts
    for banned in ("Notice period", "rotational", "Bond period", "Walk-in"):
        assert banned not in texts


@pytest.mark.parametrize(
    ("title", "expected"),
    [("Staff Nurse", "Registered Nurses"), ("ITI Electrician", "Electricians"), ("Advocate", "Lawyers"),
     ("Tally Operator", "Bookkeeping, Accounting, and Auditing Clerks"), ("GST Consultant", "Tax Preparers"),
     ("S/W Engg", "Software Developers")],
)
def test_indian_titles_map_to_occupations(title, expected):
    assert expected in {m.occupation for m in R.match_title(title, top=4)}


def test_title_abbreviations_expand():
    assert R._india_normalise("Sr. Asst. Mgr - Finance") == "senior assistant manager finance"


def test_fresher_job_does_not_demand_years_and_government_notices_are_flagged():
    jd = "Job Title: Software Engineer\nRequirements:\n- 0-2 yrs experience, freshers can apply\n- Java and SQL\n"
    r = assess_pair("Education\nB.Tech Computer Science\nProjects\n- Built a Java and SQL app", jd, as_of=AS_OF)
    assert r["years"]["required"] in (None, "0") and r["tier"] != "Abstain"
    gov = assess_pair("Experience\nClerk 2015-2024", "Advt No. 12/2026\nRequirements:\n- Typing and computer skills\n", as_of=AS_OF)
    assert gov["tier"] == "Comparison only" and gov["verdict"] is None
