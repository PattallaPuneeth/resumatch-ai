"""Seniority signal: years required by a JD vs years shown on a resume (explanation only)."""

from __future__ import annotations

from datetime import date

import pytest

from ml.pipelines.matching.seniority import (
    experience_years,
    required_years,
    seniority_fit,
    seniority_level,
)

TODAY = date(2026, 10, 1)


def test_dated_roles_are_merged_and_summed() -> None:
    text = (
        "EXPERIENCE\n"
        "Senior Engineer, Acme (Jan 2020 - Present)\n"
        "Engineer, Beta (Mar 2016 - Dec 2019)\n"
        "Contract work (2019 - 2020)\n"  # overlaps the two roles above
    )
    assert experience_years(text, TODAY) == pytest.approx(10.6, abs=0.15)


def test_education_dates_are_not_experience() -> None:
    text = (
        "EDUCATION\nB.Tech Computer Science, State University (2020 - 2024)\n"
        "EXPERIENCE\nSoftware Intern, Acme (Jun 2023 - Aug 2023)"
    )
    assert experience_years(text, TODAY) == pytest.approx(0.2, abs=0.1)


def test_single_line_export_with_broken_dash() -> None:
    # Real exports put the whole resume on one line and lose the en dash to encoding
    text = (
        "EDUCATION: B.S. Accounting, Kaplan University (2009). EXPERIENCE: Accountant "
        "(2010�Present): reconciled bank transactions."
    )
    # A year without a month counts from mid-year: Jun 2010 to Oct 2026
    assert experience_years(text, TODAY) == pytest.approx(16.3, abs=0.1)


def test_stated_years_count_when_larger() -> None:
    assert experience_years("Engineer with 7+ years of backend experience.", TODAY) == 7


def test_required_years_takes_the_real_bar() -> None:
    jd = "We expect 5 or more years of backend work, including at least 2 years owning services."
    assert required_years(jd) == 5
    assert required_years("1-5 years of accounting experience") == 1
    assert required_years("Great culture, flexible hours.") is None
    assert required_years("Founded 120 years ago.") is None


def test_levels_from_titles() -> None:
    assert seniority_level("Senior Backend Engineer") == "senior"
    assert seniority_level("Junior Java Developer (entry-level)") == "junior"
    assert seniority_level("Data Analyst") is None


def test_fit_statuses() -> None:
    fresher = "Software Intern, Acme (Jun 2025 - Aug 2025)"
    assert seniority_fit("Senior Engineer", "5+ years required", fresher)["status"] == "below"
    mid = "Engineer (2022 - Present)"
    assert seniority_fit("Engineer", "5+ years required", mid)["status"] in ("close", "below")
    assert seniority_fit("Engineer", "no years mentioned", mid)["status"] == "unknown"
    veteran = "Engineer (2010 - Present)"
    fit = seniority_fit("Senior Engineer", "5+ years", veteran)
    assert fit["status"] == "meets" and fit["jobLevel"] == "senior" and fit["requiredYears"] == 5


def test_open_ended_and_two_digit_years() -> None:
    # Found with the human labels: "(2025–)" is a current role, "(2022–25)" a two-digit end year
    text = "EXPERIENCE: Graduate RA, Missouri S&T (2025–); SWE-II, Kona Software Lab (2022–25)."
    assert experience_years(text, TODAY) == pytest.approx(4.3, abs=0.1)


def test_university_jobs_count_but_degrees_do_not() -> None:
    text = (
        "EDUCATION: B.Sc in CSE (CGPA 3.75), Chittagong Univ. (2019–24); PhD, MIT (2018–2023). "
        "EXPERIENCE: Lecturer, East Delta Univ. (2025–)"
    )
    assert experience_years(text, TODAY) == pytest.approx(1.3, abs=0.1)
