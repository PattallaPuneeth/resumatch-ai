"""
Fact-Grounded STAR Bullet Rewriter Service (Phase 4B).
Orchestrates PII redaction, prompt construction, LLM Gateway invocation,
PII restoration, and fact-grounded verification.
"""

from __future__ import annotations

import logging

import httpx
from ml.pipelines.llm.gateway import (
    LLMGateway,
    RewriterGatewayResult,
    llm_gateway,
)
from ml.pipelines.llm.safety import (
    RedactionResult,
    detect_prompt_injection,
    redact_pii,
)
from ml.pipelines.rewriter.models import (
    BulletRewriteRequest,
    LLMRewriterOption,
    RewriterServiceResponse,
    VerifiedRewriteOption,
)
from ml.pipelines.rewriter.prompt import PROMPT_VERSION, build_rewriter_prompts
from ml.pipelines.rewriter.verifier import BulletRewriteVerifier

logger = logging.getLogger("resumatch-rewriter-service")


class BulletRewriterService:
    """Service handling truth-grounded STAR bullet rewrites."""

    def __init__(
        self,
        gateway: LLMGateway | None = None,
        verifier: BulletRewriteVerifier | None = None,
    ) -> None:
        self.gateway = gateway or llm_gateway
        self.verifier = verifier or BulletRewriteVerifier()

    @staticmethod
    def _restore_pii_in_text(text: str, redaction: RedactionResult) -> str:
        """Restores PII placeholders back to original strings using RedactionResult mapping."""
        if not text:
            return text
        restored = text
        for placeholder, original in redaction.replacement_map.items():
            if placeholder in restored:
                restored = restored.replace(placeholder, original)
        return restored

    async def rewrite_bullet(
        self,
        request: BulletRewriteRequest,
        http_client: httpx.AsyncClient | None = None,
    ) -> RewriterServiceResponse:
        """
        Executes the bullet rewrite pipeline:
        1. Substring & length validation
        2. Prompt injection defense
        3. PII Redaction
        4. LLM Gateway generation (temperature 0)
        5. PII Restoration
        6. Fact-grounded verification & hallucination filtering
        """
        original_bullet = request.original_bullet.strip()
        raw_text = request.resume_raw_text

        # 1. Exact substring validation
        if original_bullet not in raw_text:
            raise ValueError("originalBullet must be an exact substring of ParsedResume.rawText")

        if len(original_bullet) > 500:
            raise ValueError("originalBullet must not exceed 500 characters")

        # 2. Prompt injection detection
        injection_in_bullet = detect_prompt_injection(original_bullet)
        injection_in_job = (
            detect_prompt_injection(request.job_text) if request.job_text else False
        )
        if injection_in_bullet or injection_in_job:
            logger.warning(
                "Potential prompt injection detected in rewrite request for resume %s. "
                "Untrusted delimiter framing active.",
                request.resume_id,
            )

        # 3. PII Redaction
        bullet_redaction = redact_pii(original_bullet)
        context_redaction = redact_pii(raw_text)
        job_redaction = redact_pii(request.job_text) if request.job_text else None

        # 4. Build Prompts
        system_prompt, user_prompt = build_rewriter_prompts(
            redacted_bullet=bullet_redaction.redacted_text,
            redacted_context=context_redaction.redacted_text,
            redacted_job=job_redaction.redacted_text if job_redaction else None,
            target_skill=request.target_skill,
        )

        # 5. Invoke LLM Gateway
        cache_key_inputs = (
            f"{bullet_redaction.redacted_text}:"
            f"{request.target_skill or ''}:"
            f"{job_redaction.redacted_text if job_redaction else ''}"
        )

        exec_res: RewriterGatewayResult = await self.gateway.execute_rewriter(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            cache_key_inputs=cache_key_inputs,
            prompt_version=PROMPT_VERSION,
            http_client=http_client,
        )

        # 6. PII Restoration & Verification
        raw_options = exec_res.llm_response.options
        restored_options: list[LLMRewriterOption] = []
        for opt in raw_options:
            restored_text = self._restore_pii_in_text(opt.text, bullet_redaction)
            restored_quotes = [
                self._restore_pii_in_text(q, bullet_redaction) for q in opt.evidence_quotes
            ]
            restored_options.append(
                LLMRewriterOption(
                    text=restored_text,
                    evidence_quotes=restored_quotes,
                    needs_user_input=opt.needs_user_input,
                )
            )

        verified_options: list[VerifiedRewriteOption] = self.verifier.verify_all(
            options=restored_options,
            original_bullet=original_bullet,
            raw_text=raw_text,
        )

        # Stateless logging: log provider, model, token counts, latency, and count ONLY
        # NEVER log bullet text or candidate PII!
        status_str = "SUCCESS" if verified_options else "HALLUCINATION_DETECTED"
        logger.info(
            "Bullet rewriter completed: status=%s provider=%s model=%s "
            "tokens_prompt=%d tokens_completion=%d latency_ms=%d verified_options=%d",
            status_str,
            exec_res.provider,
            exec_res.model,
            exec_res.tokens_prompt,
            exec_res.tokens_completion,
            exec_res.latency_ms,
            len(verified_options),
        )

        return RewriterServiceResponse(
            status="SUCCESS" if verified_options else "HALLUCINATION_DETECTED",
            original_bullet=original_bullet,
            options=verified_options,
            provider=exec_res.provider,
            model=exec_res.model,
            tokens_prompt=exec_res.tokens_prompt,
            tokens_completion=exec_res.tokens_completion,
            latency_ms=exec_res.latency_ms,
        )
