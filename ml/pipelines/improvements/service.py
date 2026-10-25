"""
Phase 4C: Resume Improvements Service.
Coordinates deterministic ATS hazard remediation, content findings analysis,
ML-ranked role suggestions, and LLM explanation generation with fail-open fallback.
"""

from __future__ import annotations

import hashlib
import logging

import numpy as np
import psycopg
from ml.config import settings
from ml.pipelines.embeddings.embedder import generate_embeddings
from ml.pipelines.improvements.ats_mapper import map_ats_hazards_to_fixes
from ml.pipelines.improvements.content_analyzer import analyze_content
from ml.pipelines.improvements.models import (
    ImprovementsRequest,
    ImprovementsResponse,
    LLMExplanation,
)
from ml.pipelines.improvements.prompt import IMPROVEMENTS_PROMPT_VERSION, build_improvements_prompt
from ml.pipelines.improvements.role_matcher import suggest_roles
from ml.pipelines.llm.gateway import LLMGateway, LLMUnavailableError, llm_gateway
from ml.pipelines.llm.grounding import GroundingVerificationError
from ml.pipelines.llm.safety import RedactionResult, detect_prompt_injection, redact_pii
from pgvector.psycopg import register_vector  # type: ignore[import-untyped]

logger = logging.getLogger("resumatch-ml-improvements-service")


def fetch_resume_vector(resume_id: str, raw_text: str) -> np.ndarray:
    """
    Fetches stored pgvector embeddings for resume_chunks and computes the normalized mean.
    If no stored chunk vectors exist (e.g., in unit tests), generates an embedding directly
    from the rawText excerpt without re-embedding the whole resume.
    """
    try:
        with psycopg.connect(settings.database_url) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT embedding
                    FROM resume_chunks
                    WHERE "resumeId" = %s AND embedding IS NOT NULL;
                    """,
                    (resume_id,),
                )
                rows = cur.fetchall()
                if rows:
                    vecs = [np.asarray(r[0], dtype=np.float32) for r in rows if r[0] is not None]
                    if vecs:
                        mean_vec = np.mean(vecs, axis=0)
                        norm = np.linalg.norm(mean_vec)
                        return (mean_vec / norm) if norm > 1e-8 else mean_vec
    except Exception as e:
        logger.debug("Database chunk vector retrieval bypassed/failed: %s", e)

    # Fallback when database chunks are not available: embed first 1000 chars of rawText
    sample = raw_text[:1000] if raw_text else "Software Engineer"
    vec_list = generate_embeddings([sample])
    if vec_list:
        v = np.asarray(vec_list[0], dtype=np.float32)
        norm = np.linalg.norm(v)
        return (v / norm) if norm > 1e-8 else v

    return np.zeros(384, dtype=np.float32)


class ResumeImprovementsService:
    """Orchestrates Phase 4C resume analysis, role matching, and explanation generation."""

    def __init__(self, gateway: LLMGateway | None = None) -> None:
        self.gateway = gateway or llm_gateway

    @staticmethod
    def _restore_pii_in_text(text: str, redaction: RedactionResult) -> str:
        """Restores original PII values from RedactionResult.replacement_map."""
        restored = text
        for placeholder, original in redaction.replacement_map.items():
            restored = restored.replace(placeholder, original)
        return restored

    async def generate_improvements(self, req: ImprovementsRequest) -> ImprovementsResponse:
        """
        Executes synchronous improvements analysis for a parsed resume.
        Deterministic findings are always computed and returned.
        If LLM tiers fail or verifier rejects, llmStatus is set to 'UNAVAILABLE'.
        """
        # 1. Deterministic ATS hazard mapping
        ats_score, ats_fixes = map_ats_hazards_to_fixes(req.atsScore, req.atsHazards)

        # 2. Deterministic Content Analyzer findings
        content_findings = analyze_content(req.resumeRawText)

        # 3. ML-Ranked Role Suggestions
        resume_vector = fetch_resume_vector(req.resumeId, req.resumeRawText)
        suggested_roles = suggest_roles(
            resume_vector=resume_vector,
            skills_data=req.candidateSkills,
            raw_text=req.resumeRawText,
            top_k=5,
        )

        # 4. Prompt Injection Check
        is_injection = detect_prompt_injection(req.resumeRawText)
        if is_injection:
            logger.warning(
                "Prompt injection detected in resume %s. Skipping LLM explanation call.",
                req.resumeId,
            )
            return ImprovementsResponse(
                atsScore=ats_score,
                atsFixes=ats_fixes,
                contentFindings=content_findings,
                suggestedRoles=suggested_roles,
                explanation=None,
                llmStatus="UNAVAILABLE",
            )

        # 5. PII Redaction
        redaction = redact_pii(req.resumeRawText)

        # 6. Build LLM Prompts
        system_prompt, user_prompt, _, _ = build_improvements_prompt(
            redacted_raw_text=redaction.redacted_text,
            ats_score=ats_score,
            ats_fixes=ats_fixes,
            content_findings=content_findings,
            suggested_roles=suggested_roles,
        )

        # 7. Execute LLM Gateway with Grounding Verification and Graceful Failover
        raw_digest = hashlib.sha256(req.resumeRawText.encode("utf-8")).hexdigest()
        cache_key_inputs = f"improvements:{raw_digest}"

        try:
            gw_result = await self.gateway.execute_improvements(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                prompt_version=IMPROVEMENTS_PROMPT_VERSION,
                cache_key_inputs=cache_key_inputs,
            )

            # Grounding verification: evidence quotes must map to rawText
            evidence_quotes = gw_result.llm_response.evidence_quotes
            if evidence_quotes:
                for q in evidence_quotes:
                    span = redaction.map_quote_to_original(q)
                    if span is None and q not in req.resumeRawText:
                        raise GroundingVerificationError(
                            f"Fabricated quote detected in explanation: {q}",
                            rate=1.0,
                            dropped=1,
                            total=len(evidence_quotes),
                        )

            # Restore any PII placeholders in LLM summary and next steps
            restored_summary = self._restore_pii_in_text(
                gw_result.llm_response.summary, redaction
            )
            restored_steps = [
                self._restore_pii_in_text(step, redaction)
                for step in gw_result.llm_response.prioritized_next_steps
            ]

            logger.info(
                "Improvements explanation generated: provider=%s, model=%s, tokens_prompt=%d, "
                "tokens_completion=%d, latency=%dms",
                gw_result.provider,
                gw_result.model,
                gw_result.tokens_prompt,
                gw_result.tokens_completion,
                gw_result.latency_ms,
            )

            return ImprovementsResponse(
                atsScore=ats_score,
                atsFixes=ats_fixes,
                contentFindings=content_findings,
                suggestedRoles=suggested_roles,
                explanation=LLMExplanation(
                    summary=restored_summary,
                    prioritizedNextSteps=restored_steps,
                ),
                llmStatus="SUCCESS",
                provider=gw_result.provider,
                model=gw_result.model,
                tokensPrompt=gw_result.tokens_prompt,
                tokensCompletion=gw_result.tokens_completion,
                latencyMs=gw_result.latency_ms,
            )

        except (LLMUnavailableError, GroundingVerificationError) as err:
            logger.warning(
                "LLM explanation unavailable or unverified for resume %s: %s. "
                "Returning deterministic findings.",
                req.resumeId,
                err,
            )
            return ImprovementsResponse(
                atsScore=ats_score,
                atsFixes=ats_fixes,
                contentFindings=content_findings,
                suggestedRoles=suggested_roles,
                explanation=None,
                llmStatus="UNAVAILABLE",
            )
        except Exception as e:
            logger.error(
                "Unexpected failure in improvements explanation generation: %s",
                e,
                exc_info=True,
            )
            return ImprovementsResponse(
                atsScore=ats_score,
                atsFixes=ats_fixes,
                contentFindings=content_findings,
                suggestedRoles=suggested_roles,
                explanation=None,
                llmStatus="UNAVAILABLE",
            )
