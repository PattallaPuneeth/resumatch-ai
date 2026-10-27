"""
Mock OpenAI-compatible LLM for load testing (Phase 10B).

Serves POST /chat/completions with schema-valid, grounded JSON so the real gateway
(redaction, schema validation, grounding verification, caching) runs end to end
without any third-party provider call. Never deploy this service to production.

Env:
  MOCK_LLM_LATENCY_MS  base response latency (default 800), +/-20% jitter
  MOCK_LLM_FAIL_RATE   fraction of requests answered with HTTP 503 (default 0.0)
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import re
import threading
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

LATENCY_MS = int(os.getenv("MOCK_LLM_LATENCY_MS", "800"))
FAIL_RATE = float(os.getenv("MOCK_LLM_FAIL_RATE", "0.0"))

DATA_BLOCK = re.compile(r"<<<DATA_(\w+)>>>\n(.*?)\n<<</DATA_\1>>>", re.DOTALL)
# Redaction placeholders such as [EMAIL_ADDRESS]; grounding rejects quotes that contain them.
PLACEHOLDER = re.compile(r"\[[A-Z_]+\]")

app = FastAPI(title="resumatch-mock-llm")

_lock = threading.Lock()
_stats = {"requests": 0, "analysis": 0, "rewriter": 0, "improvements": 0, "injected_failures": 0}


def _bump(key: str) -> None:
    with _lock:
        _stats[key] += 1


def _pick_quote(text: str) -> str:
    """Returns a verbatim substring of `text` suitable as grounded evidence."""
    for line in text.splitlines():
        line = line.strip()
        if len(line) >= 20 and not PLACEHOLDER.search(line):
            if len(line) <= 80:
                return line
            cut = line[:80]
            return cut[: cut.rfind(" ")] if " " in cut else cut
    return text.strip()[:80]


def _analysis(resume: str) -> dict[str, Any]:
    quote = _pick_quote(resume)
    return {
        "summary": "Mock analysis: candidate shows relevant experience for the role.",
        "strengths": [
            {"point": "Relevant experience", "requirement": "Core role requirement", "evidence_quote": quote}
        ],
        "gaps": [
            {
                "requirement": "Cloud certification",
                "importance": "nice",
                "explanation": "No certification is listed.",
                "suggested_fix": "Add any relevant certification you hold.",
            }
        ],
        "prioritized_improvements": [
            {"action": "Quantify impact in recent bullets", "reason": "Measurable results read stronger."}
        ],
    }


def _rewriter(context: str) -> dict[str, Any]:
    quote = _pick_quote(context)
    return {"options": [{"text": quote, "evidenceQuotes": [quote], "needsUserInput": False}]}


def _improvements(resume: str) -> dict[str, Any]:
    return {
        "summary": "Mock improvements summary.",
        "prioritizedNextSteps": ["Quantify impact in recent bullets"],
        "evidenceQuotes": [_pick_quote(resume)],
    }


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/stats")
async def stats() -> dict[str, int]:
    with _lock:
        return dict(_stats)


@app.post("/chat/completions")
async def chat_completions(request: Request) -> JSONResponse:
    _bump("requests")
    body = await request.json()
    messages = body.get("messages", [])
    system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
    user = next((m.get("content", "") for m in messages if m.get("role") == "user"), "")

    jitter = LATENCY_MS * random.uniform(-0.2, 0.2)
    await asyncio.sleep(max(0.0, (LATENCY_MS + jitter) / 1000))

    if FAIL_RATE > 0 and random.random() < FAIL_RATE:
        _bump("injected_failures")
        return JSONResponse(status_code=503, content={"error": {"message": "mock injected failure"}})

    blocks = [b[1] for b in DATA_BLOCK.findall(user)]
    last_block = blocks[-1] if blocks else user

    if '"options"' in system or '"options"' in user:
        _bump("rewriter")
        content = _rewriter("\n".join(blocks) if blocks else user)
    elif "prioritizedNextSteps" in system or "prioritizedNextSteps" in user:
        _bump("improvements")
        content = _improvements(last_block)
    else:
        _bump("analysis")
        content = _analysis(last_block)

    text = json.dumps(content)
    prompt_tokens = (len(system) + len(user)) // 4
    completion_tokens = len(text) // 4
    return JSONResponse(
        content={
            "id": "mock-chatcmpl",
            "object": "chat.completion",
            "model": body.get("model", "mock"),
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }
    )
