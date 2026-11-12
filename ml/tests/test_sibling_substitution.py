from fractions import Fraction as F
from ml.scoring.pipeline_v31 import assess_pair
from ml.scoring.units import index_resume, load_idf, score_units, segment


def test_sibling_substitution_mysql_for_postgresql():
    resume = "Experience\nBackend Engineer\n- Developed databases in MySQL and Redis."
    jd = "Requirements:\n- Must have experience with PostgreSQL."
    
    idf = load_idf()
    seg = segment(jd, idf)
    idx = index_resume(resume)
    results = score_units(seg.units, idx, idf)
    
    assert len(results) == 1
    # Observed credit is 0
    assert results[0].credit == F(0)
    # High credit reflects medium substitutability (0.50)
    assert results[0].high_credit == F(1, 2)


def test_sibling_substitution_bigquery_for_snowflake():
    resume = "Experience\nData Engineer\n- Built data pipelines in BigQuery."
    jd = "Requirements:\n- Must have experience with Snowflake."
    
    idf = load_idf()
    seg = segment(jd, idf)
    idx = index_resume(resume)
    results = score_units(seg.units, idx, idf)
    
    assert len(results) == 1
    assert results[0].credit == F(0)
    assert results[0].high_credit == F(7, 10)


def test_e2e_sibling_substitution_score_range():
    resume = (
        "Experience\n"
        "Backend Developer | 2021 - 2024\n"
        "- Built web services in Python.\n"
        "- Managed databases in MySQL.\n"
        "- Deployed cloud workloads on GCP.\n"
    )
    jd = (
        "Senior Backend Engineer\n"
        "Requirements:\n"
        "- Must have 3+ years experience.\n"
        "- Must have Python.\n"
        "- Must have PostgreSQL.\n"
        "- Must have AWS.\n"
    )
    res = assess_pair(resume, jd)
    assert res["state"] == "SCORED"
    # Sibling matches provide higher high scenario
    assert res["score_range"] is not None
    low, high = res["score_range"]
    assert high > res["score"]
