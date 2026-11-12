"""
Unit tests for Step 2: AST PDF & Ingestion Hazards.
Verifies detection of CID tokens, PUA characters, ligatures,
dual-extractor disagreement, and the non-compensatory 70 cap for trapped contacts.
"""

from __future__ import annotations

from ml.pipelines.intake.hazards import analyze_ats_hazards, detect_ast_encoding_hazards
from ml.scoring.ats_score import calculate_ats_v2, evaluate_resume_checks


class TestASTEncodingHazards:
    def test_detect_ast_encoding_hazards_clean(self) -> None:
        text = "Senior Software Engineer with experience in Python and Distributed Systems."
        cid, pua, lig = detect_ast_encoding_hazards(text)
        assert cid == 0
        assert pua == 0
        assert lig == 0

    def test_detect_ast_encoding_hazards_corrupted(self) -> None:
        # Text with (cid:123), a PUA character (0xE123), and a ligature glyph (0xFB01: 'fi')
        text = "Engineered with (cid:42) and (cid:99) using icon \ue050 and \ufb01le streaming."
        cid, pua, lig = detect_ast_encoding_hazards(text)
        assert cid == 2
        assert pua == 1
        assert lig == 1

    def test_cid_tokens_hazard_deduction(self) -> None:
        checks = evaluate_resume_checks(
            is_ocr_required=False,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            contact_email="engineer@example.com",
            raw_text="Experience with (cid:10) (cid:11) (cid:12)",
            sections_found={"experience", "education", "skills"},
            cid_tokens_count=3,
        )
        res = calculate_ats_v2(checks)
        hazard_codes = [h["code"] for h in res.hazards]
        assert "CID_FONT_UNMAPPED" in hazard_codes
        cid_hazard = next(h for h in res.hazards if h["code"] == "CID_FONT_UNMAPPED")
        assert cid_hazard["points_lost"] > 0
        assert "ToUnicode" in cid_hazard["evidence"]

    def test_pua_characters_hazard_deduction(self) -> None:
        checks = evaluate_resume_checks(
            is_ocr_required=False,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            contact_email="engineer@example.com",
            raw_text="Bullet point with custom icons \ue001 \ue002 \ue003",
            sections_found={"experience", "education", "skills"},
            pua_chars_count=3,
        )
        res = calculate_ats_v2(checks)
        hazard_codes = [h["code"] for h in res.hazards]
        assert "PUA_CHARACTERS_DETECTED" in hazard_codes

    def test_ligature_characters_hazard_deduction(self) -> None:
        checks = evaluate_resume_checks(
            is_ocr_required=False,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            contact_email="engineer@example.com",
            raw_text="Profiles \ufb01le \ufb02ag",
            sections_found={"experience", "education", "skills"},
            ligature_chars_count=2,
        )
        res = calculate_ats_v2(checks)
        hazard_codes = [h["code"] for h in res.hazards]
        assert "UNEXPANDED_LIGATURES" in hazard_codes

    def test_dual_extractor_disagreement(self) -> None:
        checks = evaluate_resume_checks(
            is_ocr_required=False,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            contact_email="engineer@example.com",
            raw_text="Clean resume content",
            sections_found={"experience", "education", "skills"},
            extractor_agreement_ratio=0.62,
        )
        res = calculate_ats_v2(checks)
        hazard_codes = [h["code"] for h in res.hazards]
        assert "EXTRACTOR_DISAGREEMENT" in hazard_codes


class TestContactTrappingNonCompensatoryCap:
    def test_contact_in_header_only_caps_score_at_70(self) -> None:
        # A resume that is otherwise 100% perfect, but email is trapped strictly in margin stream
        checks = evaluate_resume_checks(
            is_ocr_required=False,
            extractability_ratio=1.0,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            contact_email="engineer@example.com",
            raw_text="Full text content with experience and education",
            sections_found={"experience", "education", "skills"},
            experience_count=2,
            education_count=1,
            skills_count=5,
            is_contact_in_header_only=True,
        )
        res = calculate_ats_v2(checks)
        hazard_codes = [h["code"] for h in res.hazards]
        assert "CONTACT_IN_HEADER_FOOTER" in hazard_codes
        # Score must be capped at 70.0 regardless of other points
        assert res.score <= 70

    def test_analyze_ats_hazards_integration_with_ast_encoding(self) -> None:
        corrupted_text = "Experience at (cid:99) with symbol \ue022 and email user@domain.com"
        result = analyze_ats_hazards(
            is_ocr_required=False,
            has_multi_column=False,
            has_tables=False,
            has_header_footer=False,
            fonts_detected={"ArialMT"},
            sections_found={"experience", "education", "skills"},
            raw_text=corrupted_text,
            is_contact_in_header_only=True,
        )
        hazard_codes = [h.code for h in result.ats_hazards]
        assert "CID_FONT_UNMAPPED" in hazard_codes
        assert "PUA_CHARACTERS_DETECTED" in hazard_codes
        assert "CONTACT_IN_HEADER_FOOTER" in hazard_codes
        assert result.ats_score <= 70.0
