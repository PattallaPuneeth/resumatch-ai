"""
Fact-Grounded Verifier for Bullet Rewriter (Phase 4B).
Validates that every metric, percentage, tool, and credential in a rewritten STAR bullet
maps directly to an exact supporting character span in ParsedResume.rawText or originalBullet.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ml.pipelines.llm.safety import strip_prompt_injection
from ml.pipelines.matching.skill_gap import load_skill_aliases
from ml.pipelines.rewriter.models import (
    EvidenceSpan,
    LLMRewriterOption,
    VerifiedRewriteOption,
)

logger = logging.getLogger("resumatch-rewriter-verifier")

# Explicit user placeholders allowed in rewrites (e.g. [add metric], [insert %], [X])
RE_PLACEHOLDER = re.compile(r"\[[^\]]+\]")

# Numbers, percentages, currencies, multipliers, bounded numbers
RE_METRICS = re.compile(
    r"\b\d+(?:,\d{3})*(?:\.\d+)?%?\b|"
    r"\$\d+(?:,\d{3})*(?:\.\d+)?[kKmMbB]?|"
    r"\b\d+\+\b|"
    r"\b\d+x\b",
    re.IGNORECASE,
)

# Known high-consequence professional credentials and degrees
CREDENTIAL_PATTERNS = {
    "pmp": re.compile(r"\b(?:PMP|Project Management Professional)\b", re.IGNORECASE),
    "cpa": re.compile(r"\bCPA\b", re.IGNORECASE),
    "cissp": re.compile(r"\bCISSP\b", re.IGNORECASE),
    "scrum_master": re.compile(r"\b(?:CSM|Certified Scrum Master|Scrum Master)\b", re.IGNORECASE),
    "phd": re.compile(r"\b(?:Ph\.?D\.?|Doctor of Philosophy)\b", re.IGNORECASE),
    "masters": re.compile(r"\b(?:Master'?s(?:\s+degree)?|M\.?S\.?|M\.?A\.?|MBA)\b", re.IGNORECASE),
    "bachelors": re.compile(r"\b(?:Bachelor'?s(?:\s+degree)?|B\.?S\.?|B\.?A\.?)\b", re.IGNORECASE),
    "aws_certified": re.compile(r"\bAWS\s+Certified\b", re.IGNORECASE),
}


@dataclass
class VerificationResult:
    is_valid: bool
    rejection_reason: str | None = None
    option: VerifiedRewriteOption | None = None


class BulletRewriteVerifier:
    """Enforces strict truth grounding on LLM-generated STAR bullet options."""

    def __init__(self) -> None:
        self._aliases: dict[str, str] = load_skill_aliases()
        # Build reverse mapping canonical -> set of alias strings
        self._canonical_to_aliases: dict[str, set[str]] = {}
        for alias, canonical in self._aliases.items():
            self._canonical_to_aliases.setdefault(canonical, set()).add(alias)
            self._canonical_to_aliases.setdefault(canonical, set()).add(canonical)

    def _get_allowed_tool_patterns(self) -> list[tuple[str, re.Pattern[str]]]:
        """Pre-compiles regexes for all known skills/tools in taxonomy."""
        patterns: list[tuple[str, re.Pattern[str]]] = []
        for canonical, aliases in self._canonical_to_aliases.items():
            sorted_aliases = sorted(aliases, key=len, reverse=True)
            escaped = [re.escape(a) for a in sorted_aliases if len(a) >= 2]
            if escaped:
                p = re.compile(r"\b(?:" + "|".join(escaped) + r")\b", re.IGNORECASE)
                patterns.append((canonical, p))
        return patterns

    def verify_option(
        self,
        option: LLMRewriterOption,
        original_bullet: str,
        raw_text: str,
    ) -> VerificationResult:
        """
        Validates an individual rewrite option.
        Returns VerificationResult with VerifiedRewriteOption if accepted, or rejection reason.
        """
        text = option.text.strip()
        if not text:
            return VerificationResult(is_valid=False, rejection_reason="Empty rewrite option text")

        # 1. Detect and evaluate placeholders
        has_placeholder = bool(RE_PLACEHOLDER.search(text))
        needs_user_input = option.needs_user_input or has_placeholder

        # Strip bracketed placeholders so numbers/text inside placeholders (e.g. [add 1-2 metrics])
        # do not trigger false invented-metric rejection.
        text_without_placeholders = RE_PLACEHOLDER.sub(" ", text)

        # Strip prompt injection commands so injected numbers/tools cannot ground hallucinations
        clean_bullet = strip_prompt_injection(original_bullet)
        clean_raw = strip_prompt_injection(raw_text)

        # 2. Check Numbers and Percentages
        # Every number/percentage in rewrite must exist in clean_bullet or clean_raw
        metrics_in_rewrite = RE_METRICS.findall(text_without_placeholders)
        for metric in metrics_in_rewrite:
            clean_metric = metric.strip().lower()
            pattern = re.compile(r"\b" + re.escape(clean_metric) + r"\b", re.IGNORECASE)
            in_bullet = bool(pattern.search(clean_bullet))
            in_raw = bool(pattern.search(clean_raw))

            if not (in_bullet or in_raw):
                digits_only = re.sub(r"[^\d.]", "", clean_metric)
                if digits_only:
                    d_pat = re.compile(r"\b" + re.escape(digits_only) + r"\b")
                    if not (d_pat.search(clean_bullet) or d_pat.search(clean_raw)):
                        logger.warning(
                            "Rejected rewrite: invented number '%s' not found in source text.",
                            metric,
                        )
                        return VerificationResult(
                            is_valid=False,
                            rejection_reason=(
                                f"Invented metric '{metric}' not found in source resume or bullet."
                            ),
                        )

        # 3. Check Tools and Technologies
        # Any tool/technology claimed in rewrite must be grounded in clean_raw or clean_bullet
        tool_patterns = self._get_allowed_tool_patterns()
        for canonical, pat in tool_patterns:
            if pat.search(text_without_placeholders):
                aliases = self._canonical_to_aliases.get(canonical, {canonical})
                grounded = False
                for a in aliases:
                    a_pat = re.compile(r"\b" + re.escape(a) + r"\b", re.IGNORECASE)
                    if a_pat.search(clean_bullet) or a_pat.search(clean_raw):
                        grounded = True
                        break

                if not grounded:
                    logger.warning(
                        "Rejected rewrite: ungrounded tool '%s' (canonical: %s) in rewrite.",
                        pat.pattern,
                        canonical,
                    )
                    return VerificationResult(
                        is_valid=False,
                        rejection_reason=(
                            f"Tool '{canonical}' not present in candidate resume "
                            "or original bullet."
                        ),
                    )

        # 4. Check Credentials & Degrees
        for cred_name, cred_pat in CREDENTIAL_PATTERNS.items():
            if cred_pat.search(text_without_placeholders):
                if not (cred_pat.search(clean_bullet) or cred_pat.search(clean_raw)):
                    logger.warning(
                        "Rejected rewrite: ungrounded credential '%s' claimed in rewrite.",
                        cred_name,
                    )
                    return VerificationResult(
                        is_valid=False,
                        rejection_reason=(
                            f"Credential '{cred_name}' not grounded in candidate resume."
                        ),
                    )

        # 5. Extract Evidence Spans
        evidence_spans: list[EvidenceSpan] = []
        for quote in option.evidence_quotes:
            q = quote.strip()
            if not q:
                continue
            idx = raw_text.find(q)
            if idx != -1:
                evidence_spans.append(
                    EvidenceSpan(start_char=idx, end_char=idx + len(q), quote=q)
                )
            else:
                b_idx = original_bullet.find(q)
                if b_idx != -1:
                    raw_b_idx = raw_text.find(original_bullet)
                    if raw_b_idx != -1:
                        start = raw_b_idx + b_idx
                        evidence_spans.append(
                            EvidenceSpan(
                                start_char=start,
                                end_char=start + len(q),
                                quote=q,
                            )
                        )

        # If LLM didn't return explicit evidenceQuotes, anchor against original bullet in raw_text
        if not evidence_spans:
            bullet_start = raw_text.find(original_bullet)
            if bullet_start != -1:
                evidence_spans.append(
                    EvidenceSpan(
                        start_char=bullet_start,
                        end_char=bullet_start + len(original_bullet),
                        quote=original_bullet,
                    )
                )

        return VerificationResult(
            is_valid=True,
            option=VerifiedRewriteOption(
                text=text,
                evidence_spans=evidence_spans,
                needs_user_input=needs_user_input,
            ),
        )

    def verify_all(
        self,
        options: list[LLMRewriterOption],
        original_bullet: str,
        raw_text: str,
    ) -> list[VerifiedRewriteOption]:
        """
        Filters all generated options through the verifier.
        Drops options that fail.
        """
        verified: list[VerifiedRewriteOption] = []
        for opt in options:
            res = self.verify_option(opt, original_bullet, raw_text)
            if res.is_valid and res.option is not None:
                verified.append(res.option)
            else:
                logger.info("Dropping hallucinated or ungrounded rewrite: %s", res.rejection_reason)

        return verified
