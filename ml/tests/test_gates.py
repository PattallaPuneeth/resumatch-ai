from datetime import date

from ml.scoring.gates import (
    CredentialFact,
    CredentialRequirement,
    EducationFact,
    evaluate_credential,
    evaluate_education,
)

AS_OF = date(2026, 11, 11)
done = lambda lvl: EducationFact(lvl, "completed")  # noqa: E731


def test_education_ladder():
    assert evaluate_education(3, [done(4)]).status == "Met"
    assert evaluate_education(3, [done(2)]).status == "Not met"
    assert evaluate_education(3, [EducationFact(3, "in_progress")]).status == "Partial"
    assert evaluate_education(3, []).status == "Unknown"  # silence is never failure
    assert evaluate_education(3, [EducationFact(3, "discontinued")]).status == "Unknown"


def test_education_experience_alternative_and_vague_equivalent():
    assert evaluate_education(3, [done(2)], alt_years=4, candidate_years=4.8).status == "Met"
    assert evaluate_education(3, [done(2)], alt_years=5, candidate_years=4.8).status == "Not met"
    assert evaluate_education(3, [], alt_years=4, candidate_years=6).status == "Met"
    assert evaluate_education(3, [], vague_equivalent=True).status == "Confirm"
    assert evaluate_education(3, [done(2)], vague_equivalent=True).status == "Confirm"


def test_credential_unknown_met_expired_inprogress():
    req = CredentialRequirement("nurse_reg", jurisdiction="IN-KA")
    assert evaluate_credential(req, [], AS_OF).status == "Unknown"
    held = CredentialFact("nurse_reg", jurisdiction="IN-KA")
    assert evaluate_credential(req, [held], AS_OF).status == "Met"
    expired = CredentialFact("nurse_reg", expiry=date(2025, 1, 1), jurisdiction="IN-KA")
    assert evaluate_credential(req, [expired], AS_OF).status == "Not met"
    assert evaluate_credential(req, [CredentialFact("nurse_reg", in_progress=True)], AS_OF).status == "Partial"
    future = CredentialFact("nurse_reg", expiry=date(2027, 1, 1))
    assert evaluate_credential(req, [future], AS_OF).status == "Met"


def test_credential_stage_pathway():
    ca = CredentialRequirement("ca", stage_ordinal=3, lower_stage_in_pathway=True)
    assert evaluate_credential(ca, [CredentialFact("ca", stage_ordinal=2)], AS_OF).status == "Partial"
    other = CredentialRequirement("wireman_b", stage_ordinal=2)
    assert evaluate_credential(other, [CredentialFact("wireman_b", stage_ordinal=1)], AS_OF).status == "Not met"


def test_credential_other_jurisdiction():
    req = CredentialRequirement("bar", jurisdiction="IN-MH")
    held = [CredentialFact("bar", jurisdiction="IN-DL")]
    assert evaluate_credential(req, held, AS_OF, "administrative_transfer").status == "Partial"
    assert evaluate_credential(req, held, AS_OF, "automatic").status == "Met"
    assert evaluate_credential(req, held, AS_OF, "exam_required").status == "Not met"
    assert evaluate_credential(req, held, AS_OF, "unknown").status == "Unknown"
