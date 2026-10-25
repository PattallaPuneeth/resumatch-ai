"""
LLM Configuration and Tier Specifications (Phase 4A).
Defines provider endpoints, model identifiers, API key bindings, and timeouts.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass

logger = logging.getLogger("resumatch-llm-config")

PROMPT_VERSION = "1.0.0"

# Default Model Identifiers
# Confirmed working as of Phase 4A verification pass (smoke test 2026-10-25).
# Override per-tier via the corresponding env var (e.g. GEMINI_MODEL, GROQ_MODEL_PRIMARY).
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash"
DEFAULT_GROQ_PRIMARY_MODEL = "openai/gpt-oss-120b"
DEFAULT_OPENROUTER_MODEL = "openrouter/free"
DEFAULT_GROQ_EMERGENCY_MODEL = "openai/gpt-oss-20b"


@dataclass(frozen=True)
class ProviderTierConfig:
    tier: int
    provider: str
    name: str
    base_url: str
    default_model: str
    env_model_var: str
    env_key_var: str
    supports_json_mode: bool = True

    def get_api_key(self) -> str | None:
        val = os.getenv(self.env_key_var, "").strip()
        return val if val else None

    def get_model(self) -> str:
        override = os.getenv(self.env_model_var, "").strip()
        return override if override else self.default_model

    def log_model_404(self) -> None:
        """Logs which model ID returned 404 and which env var overrides it."""
        model_id = self.get_model()
        env_override = os.getenv(self.env_model_var, "").strip()
        if env_override:
            logger.error(
                "[LLM 404] Tier %d (%s): model '%s' returned 404. "
                "This model was set via env var %s. "
                "Update %s to a valid model ID.",
                self.tier, self.name, model_id, self.env_model_var, self.env_model_var,
            )
        else:
            logger.error(
                "[LLM 404] Tier %d (%s): default model '%s' returned 404. "
                "Set env var %s to a valid model ID to override.",
                self.tier, self.name, model_id, self.env_model_var,
            )


TIER_DEFINITIONS: list[ProviderTierConfig] = [
    ProviderTierConfig(
        tier=1,
        provider="google",
        name="Google AI Studio",
        base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
        default_model=DEFAULT_GEMINI_MODEL,
        env_model_var="GEMINI_MODEL",
        env_key_var="GEMINI_API_KEY",
        supports_json_mode=True,
    ),
    ProviderTierConfig(
        tier=2,
        provider="groq",
        name="Groq Primary",
        base_url="https://api.groq.com/openai/v1",
        default_model=DEFAULT_GROQ_PRIMARY_MODEL,
        env_model_var="GROQ_MODEL_PRIMARY",
        env_key_var="GROQ_API_KEY",
        supports_json_mode=True,
    ),
    ProviderTierConfig(
        tier=3,
        provider="openrouter",
        name="OpenRouter Free",
        base_url="https://openrouter.ai/api/v1",
        default_model=DEFAULT_OPENROUTER_MODEL,
        env_model_var="OPENROUTER_MODEL",
        env_key_var="OPENROUTER_API_KEY",
        supports_json_mode=True,
    ),
    ProviderTierConfig(
        tier=4,
        provider="groq_emergency",
        name="Groq Emergency",
        base_url="https://api.groq.com/openai/v1",
        default_model=DEFAULT_GROQ_EMERGENCY_MODEL,
        env_model_var="GROQ_MODEL_EMERGENCY",
        env_key_var="GROQ_API_KEY",
        supports_json_mode=True,
    ),
]


class LLMSettings:
    """Manages global timeouts, deadlines, and tier initialization."""

    def __init__(self) -> None:
        self.overall_deadline_s: float = float(os.getenv("LLM_OVERALL_DEADLINE_S", "45.0"))
        self.per_call_timeout_s: float = float(os.getenv("LLM_PER_CALL_TIMEOUT_S", "15.0"))
        self.cooldown_duration_s: float = float(os.getenv("LLM_COOLDOWN_DURATION_S", "60.0"))
        self.max_tokens: int = int(os.getenv("LLM_MAX_TOKENS", "2048"))
        self.cache_ttl_seconds: int = int(os.getenv("LLM_CACHE_TTL_SECONDS", "86400"))
        self.fabricated_evidence_threshold: float = float(
            os.getenv("LLM_FABRICATED_EVIDENCE_THRESHOLD", "0.33")
        )

    def get_configured_tiers(self) -> list[ProviderTierConfig]:
        """
        Returns list of tiers that have an API key configured, emitting warnings for missing keys.
        """
        configured: list[ProviderTierConfig] = []
        for tier in TIER_DEFINITIONS:
            key = tier.get_api_key()
            if key:
                configured.append(tier)
            else:
                logger.warning(
                    "LLM Tier %d (%s) skipped: %s is not set.",
                    tier.tier,
                    tier.name,
                    tier.env_key_var,
                )
        return configured


llm_settings = LLMSettings()
