"""
Phase 10B: LLM_BASE_URL_OVERRIDE must only ever redirect tiers to a local mock host.
"""

from __future__ import annotations

import pytest

from ml.pipelines.llm.config import TIER_DEFINITIONS, validate_base_url_override


def test_no_override_uses_real_provider_endpoints(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LLM_BASE_URL_OVERRIDE", raising=False)
    for tier in TIER_DEFINITIONS:
        assert tier.get_base_url() == tier.base_url
        assert tier.get_base_url().startswith("https://")


@pytest.mark.parametrize(
    "url",
    ["http://mock-llm:8080", "http://localhost:8080/v1", "http://127.0.0.1:9999"],
)
def test_override_accepts_local_mock_hosts(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    monkeypatch.setenv("LLM_BASE_URL_OVERRIDE", url)
    for tier in TIER_DEFINITIONS:
        assert tier.get_base_url() == url


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com",
        "https://openrouter.ai/api/v1",
        "http://mock-llm.attacker.net:8080",
        "http://localhost.attacker.net",
        "ftp://localhost/x",
        "mock-llm:8080",
    ],
)
def test_override_rejects_non_local_hosts(monkeypatch: pytest.MonkeyPatch, url: str) -> None:
    monkeypatch.setenv("LLM_BASE_URL_OVERRIDE", url)
    with pytest.raises(ValueError, match="local mock host"):
        TIER_DEFINITIONS[0].get_base_url()
    with pytest.raises(ValueError):
        validate_base_url_override(url)


def test_blank_override_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LLM_BASE_URL_OVERRIDE", "   ")
    assert TIER_DEFINITIONS[2].get_base_url() == "https://openrouter.ai/api/v1"
