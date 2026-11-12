from datetime import date

from ml.scoring.item1_extraction import assess_software_it_skills
from ml.scoring.item1_years import assess_years, jd_title_terms

AS_OF = date(2026, 11, 11)


def _years(resume: str, jd: str):
    units = assess_software_it_skills(resume, jd)["units"]
    return assess_years(resume, jd, units, as_of=AS_OF)


def test_numeric_month_year_dates_and_glued_words():
    resume = (
        "Work HistorySoftware Engineer,04/2018toCurrentAcme,Working in Python and Docker."
        "Intern,05/2017to07/2017Initech,Wrote Python scripts.Education"
    )
    r = _years(resume, "Software Engineer\nRequirements\n- Python\n- Docker\n3+ years of experience\n")
    assert r.source == "dated_relevant_roles"
    assert r.candidate_years is not None and r.candidate_years > 8


def test_study_dates_are_not_job_experience():
    resume = (
        "ExperienceDeveloper,01/2020-12/2022Acme,Built Python services.\n"
        "Expected in05/2015toBachelor of Science:Computer Science"
    )
    r = _years(resume, "Developer\n- Python\n2 years of experience\n")
    assert r.candidate_years is not None and r.candidate_years < 3  # the degree years are not counted


def test_title_match_counts_a_role_but_a_generic_word_alone_does_not():
    jd = "Job Title: Data Engineer\n- Spark pipelines\nMinimum 3 years of experience.\n"
    same_title ="ExperienceData Engineer,01/2015-12/2020Acme,Handled the books."
    r = _years(same_title, jd)
    assert r.source == "dated_relevant_roles"  # the role title matches both words of the job title
    other = "ExperienceSoftware Engineer,01/2015-12/2020Acme,Handled the books."
    assert _years(other, jd).source == "no_dated_experience"  # only "engineer" matches


def test_removing_evidence_never_adds_experience():
    jd = "Job Title: Data Engineer\n- Spark pipelines\nMinimum 3 years of experience.\n"
    with_evidence ="ExperienceAnalyst,01/2015-12/2020Acme,Built Spark pipelines."
    without = "ExperienceAnalyst,01/2015-12/2020Acme,Built reports."
    a, b = _years(with_evidence, jd), _years(without, jd)
    assert (b.candidate_years or 0) <= (a.candidate_years or 0)


def test_jd_title_terms_from_common_headers():
    assert "accou" in jd_title_terms("Job Title: Senior AccountantLocation: Atlanta, GA")
    assert "softw" in jd_title_terms("Software Developer\nWe build things.")


def test_domain_skills_beyond_it_are_found_literally():
    jd = "Staff Accountant\nRequirements\n- Accounts Payable\n- General Ledger\n- QuickBooks\n"
    resume = "Experience\nStaff Accountant 2019-2023\n- Processed accounts payable and posted to the general ledger.\n"
    units = {u["skill"]: u for u in assess_software_it_skills(resume, jd)["units"]}
    assert units["Accounts Payable"]["credit"] > 0 and units["General Ledger"]["credit"] > 0
    assert units["QuickBooks"]["credit"] == 0  # silence is "Not evidenced", never invented
