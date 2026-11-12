from ml.models.resume import ContactInfo, ExperienceItem
from ml.pipelines.intake.hazards import (
    analyze_ats_hazards,
    has_quantified_metric,
    is_ats_compliant_font,
    starts_with_action_verb,
)
from ml.scoring.ats_score import (
    Check,
    calculate_ats_v2,
)

# =============================================================================
# Helper Unit Tests: Font compliance, Metrics, Action Verbs
# =============================================================================


def test_font_compliance_patterns() -> None:
    # Classic fonts
    assert is_ats_compliant_font("Arial")
    assert is_ats_compliant_font("Calibri-Bold")
    assert is_ats_compliant_font("TimesNewRomanPSMT")
    # LaTeX / Scientific fonts
    assert is_ats_compliant_font("LMRoman10-Regular")
    assert is_ats_compliant_font("CMR10")
    assert is_ats_compliant_font("CMSY10")
    assert is_ats_compliant_font("CharterBT-Roman")
    # Modern developer fonts
    assert is_ats_compliant_font("Inter-SemiBold")
    assert is_ats_compliant_font("FiraCode-Retina")
    assert is_ats_compliant_font("JetBrainsMono-Regular")
    # Icon fonts (should not fail compliance)
    assert is_ats_compliant_font("FontAwesome5Brands-Regular")
    # Truly non-standard font
    assert not is_ats_compliant_font("ComicSansCustomWeird")


def test_metric_detection() -> None:
    assert has_quantified_metric("Achieved a 1.9x speedup in distributed training")
    assert has_quantified_metric("Reduced API response times by 40%+")
    assert has_quantified_metric("Ensured 99.9% uptime and fault tolerance")
    assert has_quantified_metric("Led a team of 4 engineers")
    assert has_quantified_metric("Saved $50k in infrastructure costs")
    assert has_quantified_metric("Handled over 500k monthly requests")
    # 4-digit years should not trigger as metrics
    assert not has_quantified_metric("Graduated in 2024 from university")
    assert not has_quantified_metric("Worked from 2021 to 2023 at company")


def test_action_verbs_detection() -> None:
    assert starts_with_action_verb("Architected high-throughput microservices")
    assert starts_with_action_verb("Engineered distributed data pipelines")
    assert starts_with_action_verb("Developed a full-stack web application")
    assert starts_with_action_verb("• Optimized backend SQL queries")
    assert starts_with_action_verb("- Spearheaded cross-functional initiative")
    assert not starts_with_action_verb("Was responsible for daily meetings")
    assert not starts_with_action_verb("Helped with customer support")


# =============================================================================
# Specification Test Matrix: ATS Score & Job Match Invariants
# =============================================================================


def test_1_clean_single_column_resume_zero_metrics_stays_high() -> None:
    """
    Test 1: Clean single-column resume with zero metrics.
    Rule: Absent is not broken. Metrics are editorial suggestions, not parser failure.
    ATS Score must stay 100.
    """
    contact = ContactInfo(name="Jane Doe", email="jane@example.com", phone="555-123-4567")
    exp = [
        ExperienceItem(
            title="Software Engineer",
            company="Tech Corp",
            bullets=[
                "Architected backend microservices using Python and PostgreSQL.",
                "Collaborated with cross functional product teams on core features.",
            ],
        )
    ]
    raw_text = (
        "Jane Doe\njane@example.com\n555-123-4567\nExperience\nArchitected backend microservices."
    )
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Arial", "LMRoman10"},
        sections_found={"experience", "education", "skills"},
        contact=contact,
        experience_items=exp,
        raw_text=raw_text,
    )
    assert res.ats_score == 100.0
    assert len(res.ats_hazards) == 0
    assert res.rubric_version == "ats-v2"
    assert res.coverage == 1.0


def test_2_phone_number_absent_no_deduction() -> None:
    """
    Test 2: Phone number absent.
    Rule: Absent is not broken. Candidate intentionally omitted phone number.
    Score must not deduct.
    """
    contact = ContactInfo(name="Student Dev", email="student@example.com", phone=None)
    projects = [
        ExperienceItem(
            title="AI Platform",
            company="Project",
            bullets=["Architected microservices handling 100k requests."],
        )
    ]
    raw_text = "Student Dev\nstudent@example.com\nProjects\nArchitected microservices handling 100k requests."
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"LMRoman10"},
        sections_found={"projects", "education", "skills"},
        contact=contact,
        experience_items=projects,
        experience_source="projects",
        raw_text=raw_text,
    )
    assert res.ats_score == 100.0
    assert len(res.ats_hazards) == 0


def test_3_email_visible_in_raw_text_missing_in_parsed_fields() -> None:
    """
    Test 3: Email visible in raw text, but missing in parsed fields.
    Rule: Visible but unparsed IS broken. Deducts from parse integrity with evidence.
    """
    contact = ContactInfo(name="Jane Doe", email=None, phone=None)
    raw_text = "Jane Doe\njane.doe@company.org\nCall me at +1 555-123-4567\nExperience..."
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Arial"},
        sections_found={"experience", "education", "skills"},
        contact=contact,
        raw_text=raw_text,
    )
    hazard_codes = [h.code for h in res.ats_hazards]
    assert "EXTRACTION_MISSED_EMAIL" in hazard_codes
    assert res.ats_score < 100.0
    # Every deduction carries evidence and fix
    email_hazard = next(h for h in res.ats_hazards if h.code == "EXTRACTION_MISSED_EMAIL")
    assert "jane.doe@company.org" in email_hazard.description
    assert "Remediation:" in email_hazard.description


def test_4_section_detector_unknown_excluded_from_denominator() -> None:
    """
    Test 4: Unknown check excluded from denominator and score renormalized.
    Rule: Unknown is not zero.
    """
    checks = [
        Check(
            id="c1",
            category="parse_integrity",
            max_points=40.0,
            earned_points=36.0,
            status="passed",
        ),
        Check(
            id="c2_unknown",
            category="layout_safety",
            max_points=20.0,
            earned_points=0.0,
            status="unknown",  # Could not run!
        ),
        Check(
            id="c3",
            category="structure",
            max_points=20.0,
            earned_points=20.0,
            status="passed",
        ),
    ]
    res = calculate_ats_v2(checks)
    # Total evaluated = 40 + 20 = 60 pts. Earned = 36 + 20 = 56 pts.
    # Score = round(100 * 56 / 60) = 93
    assert res.score == 93
    assert "c2_unknown" in res.unknown_checks
    # Coverage = 60 / 80 = 0.75
    assert res.coverage == 0.75


def test_5_student_resume_projects_only_no_structure_penalty() -> None:
    """
    Test 5: Student resume with projects only satisfies Standard Structure.
    Rule: Experience is not mandatory if Projects or Education is present.
    """
    contact = ContactInfo(name="Grad Dev", email="grad@university.edu")
    projects = [
        ExperienceItem(
            title="Distributed Key-Value Store",
            company="Open Source Project",
            bullets=["Implemented Raft consensus in Go."],
        )
    ]
    raw_text = "Grad Dev\ngrad@university.edu\nProjects\nImplemented Raft consensus in Go."
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Inter"},
        sections_found={"projects", "education", "skills"},
        contact=contact,
        experience_items=projects,
        experience_source="projects",
        raw_text=raw_text,
    )
    assert not any("MISSING_SECTION_EXPERIENCE" in h.code for h in res.ats_hazards)
    assert res.ats_score == 100.0


def test_6_two_column_pdf_layout_hazard_flagged_with_fix() -> None:
    """
    Test 6: Two-column layout triggers MULTI_COLUMN_LAYOUT with actionable fix.
    """
    contact = ContactInfo(name="Dev", email="dev@example.com")
    exp = [ExperienceItem(title="Engineer", company="Tech", bullets=["Built systems."])]
    raw_text = "Dev\ndev@example.com\nExperience\nBuilt systems."
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=True,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Arial"},
        sections_found={"experience", "education", "skills"},
        contact=contact,
        experience_items=exp,
        raw_text=raw_text,
    )
    assert any(h.code == "MULTI_COLUMN_LAYOUT" for h in res.ats_hazards)
    assert res.ats_score == 80.0
    mc_hazard = next(h for h in res.ats_hazards if h.code == "MULTI_COLUMN_LAYOUT")
    assert "single-column" in mc_hazard.description


def test_7_ocr_required_deduction() -> None:
    """
    Test 7: Scanned PDF requiring OCR deducts from parse integrity.
    """
    contact = ContactInfo(name="Dev", email="dev@example.com")
    exp = [ExperienceItem(title="Engineer", company="Tech", bullets=["Built systems."])]
    raw_text = "Dev\ndev@example.com\nExperience\nBuilt systems."
    res = analyze_ats_hazards(
        is_ocr_required=True,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Arial"},
        sections_found={"experience", "education", "skills"},
        contact=contact,
        experience_items=exp,
        raw_text=raw_text,
    )
    assert any(h.code == "OCR_REQUIRED" for h in res.ats_hazards)
    assert res.ats_score == 70.0


def test_10_old_client_reading_ats_score_tuple_compatibility() -> None:
    """
    Test 10: AtsAnalysisResult is a 2-tuple (ats_score, ats_hazards) for backward compatibility.
    Old clients unpacking score, hazards = analyze_ats_hazards(...) continue to work.
    """
    contact = ContactInfo(name="Dev", email="dev@example.com")
    raw_text = "Dev\ndev@example.com\nExperience\nBuilt systems."
    res = analyze_ats_hazards(
        is_ocr_required=False,
        has_multi_column=False,
        has_tables=False,
        has_header_footer=False,
        fonts_detected={"Arial"},
        sections_found={"experience", "education", "skills"},
        contact=contact,
        raw_text=raw_text,
    )
    score, hazards = res  # Tuple unpacking
    assert isinstance(score, float)
    assert isinstance(hazards, list)
    assert score == 100.0
