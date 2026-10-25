"""
Smoke test for Phase 4B: Fact-Grounded STAR Bullet Rewriter.
Gated by RUN_LIVE_LLM=1 (default off).
Enforces the LLM_CALL_LIMIT rule: at most ONE live call total.
"""

from __future__ import annotations

import asyncio
import os
import sys

from ml.pipelines.rewriter.models import BulletRewriteRequest
from ml.pipelines.rewriter.service import BulletRewriterService


async def run_smoke() -> None:
    run_live = os.environ.get("RUN_LIVE_LLM", "").strip() == "1"
    if not run_live:
        print("[LLM_CALL_LIMIT] RUN_LIVE_LLM is not set to '1'. Skipping live call.")
        print("[LLM_CALL_LIMIT] Exact live LLM calls made: 0.")
        return

    print("[LLM_CALL_LIMIT] RUN_LIVE_LLM=1 detected. Performing exactly ONE live smoke call...")

    service = BulletRewriterService()
    sample_bullet = (
        "Refactored payment gateway microservices to improve reliability and reduce latency."
    )
    raw_text = (
        "Jane Doe\n"
        "Senior Software Engineer\n"
        "Experience:\n"
        f"- {sample_bullet}\n"
        "Skills: Python, FastAPI, Redis, Docker, PostgreSQL."
    )

    req = BulletRewriteRequest(
        resume_id="88888888-8888-4888-a888-888888888888",
        original_bullet=sample_bullet,
        resume_raw_text=raw_text,
        target_skill="Python",
    )

    try:
        res = await service.rewrite_bullet(req)
        print("=== LIVE REWRITER RESULT ===")
        print(f"Status: {res.status}")
        print(f"Provider: {res.provider}")
        print(f"Model: {res.model}")
        print(f"Tokens Prompt: {res.tokens_prompt}")
        print(f"Tokens Completion: {res.tokens_completion}")
        print(f"Latency: {res.latency_ms}ms")
        print(f"Verified Options Count: {len(res.options)}")
        for idx, opt in enumerate(res.options, 1):
            print(f"Option {idx}: {opt.text}")
            print(f"  Needs User Input: {opt.needs_user_input}")
            print(f"  Evidence Spans: {len(opt.evidence_spans)}")

        print("\n[LLM_CALL_LIMIT] Exact live LLM calls made: 1.")
    except Exception as e:
        print(f"Live rewriter call failed: {e}", file=sys.stderr)
        raise e


def main() -> None:
    asyncio.run(run_smoke())


if __name__ == "__main__":
    main()
