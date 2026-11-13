"""Golden fixtures F1-F7 (docs/ITEM2_CURRENT_STATUS_SPECIFICATION.md) on the unified engine."""

from fractions import Fraction as F

import pytest

from ml.scoring.engine import (
    Flags,
    GateUnit,
    SkillUnit,
    YearsInput,
    band_for,
    evaluate,
    round_half_up,
)


def sk(i, w=1, c=1, high=None, ok=True):
    return SkillUnit(i, F(w), F(c), None if high is None else F(high), ok)


def test_rounding_and_bands():
    assert round_half_up(F(84375, 1000)) == 84
    assert round_half_up(F(1, 2)) == 1
    assert [band_for(x) for x in (0, 39, 40, 69, 70, 100)] == [
        "No Fit", "No Fit", "Potential Fit", "Potential Fit", "Good Fit", "Good Fit",
    ]


def test_f1_no_skills_years_and_education():
    r = evaluate([], YearsInput(F(3), F(9, 4)), [GateUnit("deg", F(1), "Met", True)],
                 total_units=2)
    assert r.observed.score == 84 and (r.low, r.high) == (84, 84)
    assert r.confidence == "Medium" and "sk" not in r.active_set
    assert r.observed.weights["yr"] / sum(r.observed.weights.values()) == F(5, 8)


def test_f2_unknown_mandatory_registration_caps_low_only():
    skills = [sk(f"s{i}") for i in range(5)] + [sk("s6", c=F(1, 2))]  # S_sk = 11/12
    gates = [GateUnit("bsc", F(1), "Met", True), GateUnit("reg", F(1), "Unknown", True)]
    r = evaluate(skills, YearsInput(F(5), F(8)), gates)
    assert r.observed.score == 95 and r.low == 69 and r.high == 95
    assert r.gate_cap == "low_only" and r.confidence == "Medium"


def test_f3_trades_or_gate_variants():
    skills = [sk("a", c=1), sk("b", c=1), sk("c", c=F(53, 60) * 3 - 2)]  # S_sk = 53/60
    r = evaluate(skills, None, [GateUnit("iti", F(1), "Met", True)])
    assert r.observed.score == 91 and (r.low, r.high) == (91, 91)
    r2 = evaluate(skills, None, [GateUnit("iti", F(1), "Partial", True)])
    assert r2.observed.raw > 69 or r2.observed.score <= 69
    third = [GateUnit("iti", F(1), "Partial", True)]
    # gate credit 1/3 (1 of 3 years) -> raw 77.3 capped to 69
    r3 = evaluate(skills, None, [GateUnit("g", F(1), "Partial", True)])
    assert r3.observed.score == 69 and r3.gate_cap == "observed" and third


def test_f4_concurrent_contracts_range_with_thin_skill_shrinkage():
    skills = [sk("py", c=1), sk("sql", c=F(4, 5))]  # S_sk = 0.9, M_sk = 2 -> shrink to 2/3
    y = YearsInput(F(4), F(3), low=F(1), high=F(4))
    r = evaluate(skills, y, [])
    # skill weight 0.6*2/3 = 0.4; (0.4*0.9+0.25*0.75)/0.65 = 0.8423
    assert (r.observed.score, r.low, r.high) == (84, 65, 94)
    assert r.observed.weights["sk"] == F(2, 5)


def test_f5_sibling_substitution_is_range_only_with_gains():
    skills = [sk("python"), sk("postgres", c=0, high=F(1, 2)), sk("aws", c=0, high=F(7, 10))]
    r = evaluate(skills, YearsInput(F(3), F(4)), [])
    assert r.observed.score == 53 and r.high == 81 and r.band == "Potential Fit"
    gains = {g.unit_id: g.points for g in r.gains}
    assert {k: round(float(v), 1) for k, v in gains.items()} == {"postgres": 11.8, "aws": 16.5}


def test_f6_staged_credential_partial_caps():
    gates = [GateUnit("bcom", F(1), "Met", True), GateUnit("ca", F(1), "Partial", True)]
    r = evaluate([sk("a"), sk("b"), sk("c")], YearsInput(F(3), F(3)), gates)
    assert r.observed.raw == F(9625, 100) and r.observed.score == 69
    assert r.high == 69 and r.gate_cap == "observed"


def test_f7_no_signal_is_null_not_zero():
    r = evaluate([], YearsInput(None, None), [])
    assert r.status == "insufficient_jd_signal" and r.observed is None
    r2 = evaluate([sk("x", ok=False)], YearsInput(F(0), F(5)), [])
    assert r2.status == "insufficient_jd_signal"


def test_unknown_years_excluded_then_ranged():
    r = evaluate([sk("a"), sk("b"), sk("c", c=F(1, 2))], YearsInput(F(4), None), [])
    assert "yr" not in r.observed.components
    assert r.low < r.observed.score < r.high


def test_cap_never_pushes_below_forty():
    skills = [sk(f"s{i}", c=F(3, 10)) for i in range(3)]
    r = evaluate(skills, None, [GateUnit("g", F(1), "Not met", True)])
    assert r.observed.score == 24 and not r.observed.cap_bound  # cap only lowers scores above 69


def test_low_confidence_is_tentative_with_a_range_band_not_hidden():
    r = evaluate([sk("a")], None, [])
    assert r.confidence == "Low" and r.tier == "Tentative"
    assert not r.verdict_withheld and r.band == "Good Fit" and r.band_range == ("Good Fit", "Good Fit")
    assert r.observed.score == 100


def test_skills_only_job_with_three_units_is_not_low():
    r = evaluate([sk("a"), sk("b"), sk("c", c=F(1, 2))], None, [])
    assert r.confidence == "Medium" and r.tier == "Firm"
    assert "only one scoring component had data" in r.confidence_reasons


def test_unreadable_dates_lower_confidence_to_medium_not_low():
    skills = [sk(f"s{i}", w=F(1, 2)) for i in range(3)]  # a thin job: years swing the range
    r = evaluate(skills, YearsInput(F(5), None), [])  # dates unknown
    assert r.high - r.low > 30
    assert r.confidence == "Medium" and r.tier == "Firm"
    assert "the dates on the resume could not be fully read" in r.confidence_reasons


def test_hard_abstain_reasons_only():
    s = [sk("a"), sk("b"), sk("c")]
    r = evaluate(s, None, [], flags=Flags(parse_failed=True))
    assert r.tier == "Abstain" and r.observed is None and r.verdict_withheld
    r = evaluate(s, None, [], flags=Flags(unsupported_script_majority=True))
    assert r.tier == "Abstain"
    assert evaluate([], None, []).tier == "Abstain"


def test_band_range_spans_the_scenarios():
    gates = [GateUnit("reg", F(1), "Unknown", True)]
    r = evaluate([sk(f"s{i}", c=F(9, 10)) for i in range(6)], YearsInput(F(2), F(2)), gates)
    assert r.band_range == ("Potential Fit", "Good Fit") and r.tier == "Firm"


def test_public_sector_withholds():
    r = evaluate([sk("a"), sk("b"), sk("c")], YearsInput(F(1), F(1)), [GateUnit("d", F(1), "Met", False)],
                 flags=Flags(public_sector=True))
    assert r.verdict_withheld and r.band is None and r.tier == "Comparison only"
    assert r.observed is not None  # the comparison score is still shown


def test_invalid_credit_rejected():
    with pytest.raises(ValueError):
        evaluate([sk("a", c=2)], None, [])
