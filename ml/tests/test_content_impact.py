"""
Unit tests for Step 3: Content Impact and Voice.
Verifies calibrated quantification saturation, separation of passive voice
and weak openers, role-scoped verb repetition.
"""

from __future__ import annotations

from dataclasses import dataclass

from ml.pipelines.intake.content_insights import (
    extract_content_insights,
)


@dataclass
class DummyExperienceItem:
    company: str
    bullets: list[str]


class TestContentImpactSuite:
    def test_calibrated_quantification_saturation(self) -> None:
        # 10 bullets: 5 quantified (50% ratio > 45% target knee)
        bullets = [
            "Increased service throughput by 45% across clusters.",
            "Reduced AWS infrastructure costs by $120k annually.",
            "Architected low-latency caching system serving 50k QPS.",
            "Managed team of 8 engineers delivering payments pipeline.",
            "Optimized query performance by 3.5x using composite indexing.",
            "Engineered event-driven pub-sub architecture using Kafka.",
            "Authored design documents and technical RFCs.",
            "Mentored junior engineers on distributed systems debugging.",
            "Collaborated with cross-functional product stakeholders.",
            "Configured CI/CD automated deployment pipelines.",
        ]
        item = DummyExperienceItem(company="TechCorp", bullets=bullets)
        insights = extract_content_insights(experience_items=[item], skills=[])

        quant_data = insights["measurable_outcomes"]
        assert quant_data["total_bullets_count"] == 10
        assert quant_data["quantified_bullets_count"] == 5
        assert quant_data["quantification_ratio"] == 0.5
        # At 50% quantification, calibrated saturation score achieves full 100.0 credit
        assert quant_data["calibrated_saturation_score"] == 100.0

    def test_disentangled_passive_voice_vs_weak_openers(self) -> None:
        # A resume that contains passive voice ("was deployed") and a weak opener ("Assisted with")
        text = "Assisted with database migration. The microservice was deployed to Kubernetes cluster."
        bullets = [
            "Assisted with database migration.",
            "Engineered deployment scripts for Kubernetes cluster.",
        ]
        item = DummyExperienceItem(company="Acme", bullets=bullets)
        insights = extract_content_insights(experience_items=[item], skills=[], raw_text=text)

        action_verbs = insights["action_verbs"]
        # Weak opener detected specifically
        assert any("assisted" in w.lower() for w in action_verbs["weak_phrases_detected"])
        # Passive voice detected as separate boolean flag
        assert action_verbs["passive_voice_detected"] is True

    def test_role_scoped_verb_repetition(self) -> None:
        # Role 1 has 3 bullets opening with "Developed" -> role-scoped repetition
        role_1 = DummyExperienceItem(
            company="Company A",
            bullets=[
                "Developed REST APIs using FastAPI.",
                "Developed frontend dashboard using Next.js.",
                "Developed automated test harness using Pytest.",
            ],
        )
        # Role 2 has only 1 bullet with "Developed" -> no repetition inside Role 2
        role_2 = DummyExperienceItem(
            company="Company B",
            bullets=[
                "Developed real-time ingestion worker.",
                "Architected Kafka event pipeline.",
            ],
        )
        insights = extract_content_insights(experience_items=[role_1, role_2], skills=[])
        action_verbs = insights["action_verbs"]

        assert "Developed" in action_verbs["role_repeated_verbs"]

    def test_bullet_brevity_has_no_readability_grade(self) -> None:
        bullets = [
            "Micro.",  # micro-bullet (< 5 words)
            "Built distributed tracing infrastructure for high-scale Kubernetes clusters across three cloud environments.",  # ideal
            "This is an extremely long, rambling and unnecessary run-on bullet point that keeps going on and on without any clear quantitative outcome or technical specificity, describing routine administrative daily tasks that could easily be summarized in a much shorter and punchier sentence for hiring managers.",  # run-on (> 35 words)
        ]
        item = DummyExperienceItem(company="Corp", bullets=bullets)
        insights = extract_content_insights(experience_items=[item], skills=[])

        brevity = insights["bullet_brevity"]
        assert brevity["micro_bullets_count"] == 1
        assert brevity["long_bullets_count"] == 1
        assert "coleman_liau_grade" not in brevity
