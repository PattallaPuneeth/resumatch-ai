from datetime import date
from decimal import Decimal

from ml.scoring.item1_years import assess_years, extract_required_years


def _skill(text, start, end, context="experience"):
    return {
        "status": "Direct",
        "context": context,
        "start": start,
        "end": end,
        "evidence": text[start:end],
    }


def test_extract_years_minimum_range_and_plus_not_maximum():
    assert extract_required_years("Requires 3–5 years of software experience.") == Decimal("3")
    assert extract_required_years("Requires 3\u20145 years of software experience.") == Decimal("3")
    assert extract_required_years("Must have 5+ years experience.") == Decimal("5")
    assert extract_required_years("Experience preferred: 4 years.") == Decimal("4")
    assert extract_required_years("No numeric duration required.") is None


def test_overlapping_dated_roles_are_unioned_with_relevant_skill_evidence():
    resume = (
        "Experience\n"
        "Engineer A | Jan 2020 - Jan 2022\n"
        "- Built Python APIs.\n"
        "Engineer B | Jun 2020 - Jun 2021\n"
        "- Built Java services.\n"
        "Education\nB.Tech 2018\n"
    )
    skill = resume.index("Python")
    result = assess_years(
        resume,
        "Requires 2 years experience with Python.",
        [_skill(resume, skill, skill + len("Python"))],
        as_of=date(2026, 11, 10),
    )
    assert result.source == "dated_relevant_roles"
    assert result.candidate_years == Decimal("2")
    assert result.years_component == Decimal(1)


def test_year_only_dates_report_precision_range():
    resume = "Experience\nDeveloper | 2020 - 2022\n- Built Python services.\n"
    skill = resume.index("Python")
    result = assess_years(
        resume,
        "3 years experience required.",
        [_skill(resume, skill, skill + 6)],
        as_of=date(2026, 11, 10),
    )
    assert result.candidate_years == Decimal("2")
    assert result.low_years == Decimal("1")
    assert result.high_years == Decimal("3")
    assert result.years_component == Decimal("0.6666666666666666666666666667")


def test_overlapping_year_only_roles_share_precision_uncertainty_cluster():
    resume = (
        "Experience\n"
        "Engineer A | 2020 - 2022\n- Built Python services.\n"
        "Engineer B | 2020 - 2022\n- Built Java services.\n"
    )
    python_start = resume.index("Python")
    java_start = resume.index("Java")
    result = assess_years(
        resume,
        "3 years experience required.",
        [
            _skill(resume, python_start, python_start + 6),
            _skill(resume, java_start, java_start + 4),
        ],
        as_of=date(2026, 11, 10),
    )
    assert result.candidate_years == Decimal("2")
    assert result.low_years == Decimal("1")
    assert result.high_years == Decimal("3")


def test_dateless_roles_without_self_report_get_zero_and_confirmed_scenario():
    resume = "Experience\nBuilt Python services.\nEducation\nB.Tech"
    skill = resume.index("Python")
    result = assess_years(
        resume,
        "3 years experience required.",
        [_skill(resume, skill, skill + 6)],
        as_of=date(2026, 11, 10),
    )
    assert result.source == "no_dated_experience"
    assert result.candidate_years == 0
    assert result.years_component == 0
    assert result.high_years == 3
    assert result.high_component == 1


def test_dateless_self_report_is_discounted_and_flagged():
    resume = "Summary: 5 years of experience.\nExperience\nBuilt Python services."
    skill = resume.index("Python")
    result = assess_years(
        resume,
        "3 years experience required.",
        [_skill(resume, skill, skill + 6)],
        as_of=date(2026, 11, 10),
    )
    assert result.source == "self_reported_discounted"
    assert result.candidate_years == Decimal("3.75")
    assert result.years_component == 1
    assert result.high_years == 5


def test_graduation_year_is_ignored_outside_experience_section():
    resume = "Education\nB.Tech 2018-2022\n"
    result = assess_years(resume, "2 years required.", [], as_of=date(2026, 11, 10))
    assert result.source == "no_dated_experience"
    assert result.candidate_years == 0


def test_single_year_role_is_counted_and_not_dropped():
    resume = "Experience\nDeveloper | 2022 - 2022\n- Built Python services.\n"
    skill = resume.index("Python")
    result = assess_years(
        resume,
        "2 years experience required.",
        [_skill(resume, skill, skill + 6)],
        as_of=date(2026, 11, 10),
    )
    assert result.source == "dated_relevant_roles"
    assert result.candidate_years == Decimal("1")
    assert result.low_years == Decimal("0")
    assert result.high_years == Decimal("2")


def test_stale_current_role_is_clamped_in_low_scenario():
    # Role started in 2018, 'Present' evaluated in 2026 (>5 years).
    # Other role ended in 2023.
    resume = (
        "Experience\n"
        "Lead Developer | 2018 - Present\n- Built Python services.\n"
        "Consultant | 2022 - 2023\n- Built Java services.\n"
    )
    py = resume.index("Python")
    java = resume.index("Java")
    result = assess_years(
        resume,
        "5 years experience required.",
        [_skill(resume, py, py + 6), _skill(resume, java, java + 4)],
        as_of=date(2026, 1, 1),
    )
    assert "stale_current_role_clamped" in result.flags
    assert result.candidate_years == Decimal("8")
    # Low scenario clamped to max(other_dates: 2023, 2018+5: 2023) -> 5 years base, minus 1 year year-only uncertainty -> 4 years
    assert result.low_years == Decimal("4")

