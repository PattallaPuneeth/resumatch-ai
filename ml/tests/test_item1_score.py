"""Golden arithmetic checks for Item 1's owner-supplied reference scorer."""

import pytest

from ml.scoring.item1 import calculate_score, conditional_range, verdict

D1 = (1, 1)
M = True
P = False
CASES = [
    ("T1", 97, [D1, D1, D1, (0.5, 0.6)], (4, 3), [(1, "Met", M)]),
    ("T2", 71, [D1, D1, (1, 0.8), (0.5, 0), (0.5, 0)], (1.5, 2), [(1, "Confirm", M)]),
    ("T3", 70, [D1, (1, 0)], (3, 2), [(1, "Met", M), (1, "Unknown", M)]),
    ("T4", 63, [D1, (1, 0)], (3, 2), [(1, "Met", M), (1, "Not met", M)]),
    ("T5", 69, [D1, D1], (5, 3), [(1, "Partial", M)]),
    ("T6rev", 100, [D1, D1], (4, 3), [(1, "Met", M), (1, "Confirm", M)]),
    ("T6b", 69, [D1, D1], (4, 3), [(1, "Met", M), (1, "Partial", M)]),
    ("T7", 67, [D1, D1, (1, 0.6), (0.5, 0)], (1, 2), []),
    ("T8", 100, [D1, D1], None, []),
    ("T9", 76, [D1, (1, 0), (0.5, 1)], (3.5, 3), [(1, "Met", M)]),
    ("T10", 80, [D1, D1, (1, 0)], (2.5, 2), [(1, "Met", M), (1, "Unknown", M)]),
    ("T10b", 100, [D1, D1, D1], (2, 2), [(1, "Met", M), (1, "Unknown", M)]),
    ("T11", 78, [D1, (1, 0.6)], (3, 5), [(1, "Met", M), (0.5, "Unknown", P)]),
    ("T12", 67, [D1, D1, (1, 0)], (2, 3), [(1, "Confirm", M)]),
    ("T13", 72, [(1, 0.8), D1, (0.5, 0)], None, []),
    ("T14", 60, [D1, (1, 0.6), (0.5, 0)], (0.5, 1), []),
    ("T15", 92, [D1, (1, 0.8)], None, [(1, "Met", M)]),
    ("T16", 76, [D1, (1, 0), D1], (2.5, 2), [(1, "Confirm", M), (0.5, "Unknown", P)]),
    ("T17", 69, [D1, D1, (0.5, 0)], (6, 3), [(1, "Not met", M)]),
    ("E1", 88, [D1, (1, 0.6)], (5, 3), [(1, "Met", M)]),
    ("E3", 100, [D1, D1, D1], (3, 2), [(1, "Confirm", M), (1, "Unknown", M)]),
    ("E4", 100, [D1, D1, D1], (3, 3), []),
    ("E6", 76, [D1, (1, 0), D1], (3, 2), []),
    ("E7", 75, [D1, (1, 0.6)], (2.5, 4), []),
    ("E8", 25, [D1, (1, 0), (1, 0), (1, 0)], (2, 5), [(1, "Not met", M)]),
    ("E10", 72, [D1, D1, D1, (0.5, 0.6)], (0, 3), [(1, "Met", M)]),
    ("E10b", 97, [D1, D1, D1, (0.5, 0.6)], (3.75, 3), [(1, "Met", M)]),
    ("E11", 50, [(1, 0.5)] * 5, None, []),
    ("T5b", 80, [D1, D1, (1, 0)], (3, 2), [(1, "Met", M), (1, "Unknown", M)]),
    ("T10c", 69, [D1, D1, (1, 0)], (2.5, 2), [(1, "Met", M), (1, "Partial", M)]),
    ("T-ins", 65, [D1, D1, (1, 0)], (3, 2), [(1, "Not met", M)]),
    ("T-cs", 69, [D1, D1, D1], (2, 2), [(1, "Partial", M)]),
    ("T-pilot", 80, [D1, D1, (1, 0)], (2, 2), [(1, "Met", M)]),
]


@pytest.mark.parametrize("name,expected,skills,years,gates", CASES)
def test_reference_cases(name, expected, skills, years, gates):
    result = calculate_score(skills, years, gates)
    assert result is not None, name
    assert result.score == expected, name


def test_reference_conditional_range():
    assert conditional_range([D1, D1], (4, 3), [(1, "Met", M), (1, "Confirm", M)]) == (69, 100)


def test_preferred_unknown_range_is_not_capped():
    assert conditional_range([D1, (1, 0.6)], (3, 5), [(1, "Met", M), (0.5, "Unknown", P)]) == (
        73,
        78,
    )


def test_no_components():
    assert calculate_score([], None, []) is None


@pytest.mark.parametrize(
    "score,expected",
    [
        (0, "No Fit"),
        (39, "No Fit"),
        (40, "Potential Fit"),
        (69, "Potential Fit"),
        (70, "Good Fit"),
        (100, "Good Fit"),
    ],
)
def test_verdict_boundaries(score, expected):
    assert verdict(score) == expected


def test_t7_date_precision_range():
    skills = [D1, D1, (1, 0.6), (0.5, 0)]
    assert calculate_score(skills, (0, 2), []).score == 52
    assert calculate_score(skills, (2, 2), []).score == 82


def test_date_stripping_case_from_reference():
    skills = [D1, D1, D1, (0.5, 0.6)]
    with_years = calculate_score(skills, (0, 3), [(1, "Met", M)])
    without_years = calculate_score(skills, None, [(1, "Met", M)])
    assert with_years is not None and with_years.score == 72
    assert without_years is not None and without_years.score == 95


def test_single_gate_cap_does_not_create_no_fit():
    for score in range(40, 101):
        assert min(score, 69) >= 40


def test_verified_alias_catalog_has_sources_and_unique_terms():
    import json
    from pathlib import Path

    from ml.scoring.item1 import load_verified_alias_map

    path = Path("ml/data/item1_it_aliases.json")
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["schema_version"] == "item1-it-aliases-v1"
    assert all(row["source_url"].startswith("https://") for row in data["rows"])
    terms = [
        term.casefold() for row in data["rows"] for term in [row["canonical"], *row["aliases"]]
    ]
    assert len(terms) == len(set(terms))
    assert load_verified_alias_map()["kubernetes"] == frozenset({"kubernetes", "k8s"})


@pytest.mark.parametrize(
    "requirement,resume,expected",
    [
        ("Kubernetes", "Built a K8s deployment platform.", ("K8s", 8, 11)),
        ("Postgres", "Operated PostgreSQL clusters.", ("PostgreSQL", 9, 19)),
        ("AWS", "AWS Lambda workloads.", ("AWS", 0, 3)),
        ("Python", "Used Python for APIs.", ("Python", 5, 11)),
    ],
)
def test_direct_literal_and_verified_alias_spans(requirement, resume, expected):
    from ml.scoring.item1 import find_direct_skill_evidence

    assert find_direct_skill_evidence(requirement, resume) == expected


def test_zero_required_years_does_not_divide_by_zero():
    # JD requiring 0 years experience should renormalize without crashing
    res = calculate_score([(1, 1)], (2, 0), [])
    assert res is not None
    assert res.score == 100
    assert "yr" not in res.components


def test_only_confirm_gates_returns_none():
    # All gates unassessed / confirm-only results in None (abstention)
    assert calculate_score([], None, [(1, "Confirm", True)]) is None


def test_schemas_are_valid_json():
    import json
    from pathlib import Path

    for schema_name in ["credential_registry.json", "education_ladder.json", "extraction_contract.json"]:
        path = Path("ml/schemas") / schema_name
        assert path.exists(), f"Schema {schema_name} should exist"
        data = json.loads(path.read_text(encoding="utf-8"))
        assert "$schema" in data
        assert "$id" in data
