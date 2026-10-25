"""
Smoke script for LLM Failover Gateway (Phase 4A).
Tests live connectivity and model validity for all tiers with configured keys.
Uses synthetic data only. Never logs or prints any secret keys.
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from ml.pipelines.llm.config import TIER_DEFINITIONS, ProviderTierConfig


async def probe_tier(tier: ProviderTierConfig, client: httpx.AsyncClient) -> bool:
    api_key = tier.get_api_key()
    if not api_key:
        print(f"[-] Tier {tier.tier} ({tier.name}): Skipped (no {tier.env_key_var} configured)")
        return True

    model_id = tier.get_model()
    endpoint = f"{tier.base_url.rstrip('/')}/chat/completions"

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if tier.provider == "openrouter":
        headers["HTTP-Referer"] = "https://resumatch.ai"
        headers["X-Title"] = "ResuMatch AI"

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": "You are a test assistant. Reply with single word: OK."},
            {"role": "user", "content": "Ping."},
        ],
        "temperature": 0.0,
        "max_tokens": 10,
    }

    t0 = time.monotonic()
    try:
        resp = await client.post(endpoint, headers=headers, json=payload, timeout=15.0)
        latency_ms = int((time.monotonic() - t0) * 1000)

        if resp.status_code == 200:
            data = resp.json()
            usage = data.get("usage", {})
            p_tok = usage.get("prompt_tokens", 0)
            c_tok = usage.get("completion_tokens", 0)
            print(
                f"[+] Tier {tier.tier} ({tier.name}): SUCCESS - model='{model_id}', "
                f"latency={latency_ms}ms, prompt_tokens={p_tok}, completion_tokens={c_tok}"
            )
            return True
        else:
            print(
                f"[!] Tier {tier.tier} ({tier.name}): FAILED (HTTP {resp.status_code}) - "
                f"model='{model_id}', reason={resp.text[:120]}"
            )
            return False
    except Exception as e:
        latency_ms = int((time.monotonic() - t0) * 1000)
        print(
            f"[!] Tier {tier.tier} ({tier.name}): ERROR ({type(e).__name__}) - "
            f"model='{model_id}', latency={latency_ms}ms: {e}"
        )
        return False


async def main() -> int:
    load_dotenv(Path(__file__).resolve().parents[2] / ".env")
    load_dotenv()

    print("=" * 60)
    print("ResuMatch AI - Phase 4A LLM Gateway Smoke Test")
    print("=" * 60)

    has_keys = any(t.get_api_key() for t in TIER_DEFINITIONS)
    if not has_keys:
        print("[INFO] No LLM API keys configured in environment. Skipping live probes.")
        print("=" * 60)
        return 0

    all_ok = True
    async with httpx.AsyncClient() as client:
        for tier in TIER_DEFINITIONS:
            ok = await probe_tier(tier, client)
            if not ok:
                all_ok = False

    print("=" * 60)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
