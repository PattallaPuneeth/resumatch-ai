"""OpenRouter JSON client with a hard call cap and a request ledger.

RULE.md S2/S4: OpenRouter only; every provider request is counted (retries included) and listed
with its timestamp, never with prompt text or keys. The cap is enforced in code before each request.
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BUDGET = ROOT / "eval-output" / "llm_budget.json"
DEFAULT_LEDGER = ROOT / "eval-output" / "llm_ledger.jsonl"
DEFAULT_CAP = 300


class BudgetExceeded(RuntimeError):
    """The approved number of provider requests has been used."""


class LLMCallFailed(RuntimeError):
    """The provider request failed or returned nothing usable."""


@dataclass
class Budget:
    path: Path
    cap: int

    def used(self) -> int:
        try:
            return int(json.loads(self.path.read_text(encoding="utf-8")).get("used", 0))
        except (OSError, ValueError):
            return 0

    def take(self) -> int:
        used = self.used()
        if used >= self.cap:
            raise BudgetExceeded(f"{used} of {self.cap} approved provider requests already used")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"used": used + 1, "cap": self.cap}), encoding="utf-8")
        return used + 1


class OpenRouterClient:
    def __init__(
        self,
        api_key: str,
        model: str,
        *,
        cap: int = DEFAULT_CAP,
        budget_path: Path = DEFAULT_BUDGET,
        ledger_path: Path = DEFAULT_LEDGER,
        timeout: float = 60.0,
        http: Any = None,
    ) -> None:
        if not api_key:
            raise ValueError("an OpenRouter API key is required")
        self._key, self.model, self.timeout = api_key, model, timeout
        self.budget = Budget(budget_path, cap)
        self.ledger_path = ledger_path
        self._http = http

    @classmethod
    def from_env(cls, **kwargs: Any) -> OpenRouterClient | None:
        key = os.getenv("OPENROUTER_API_KEY", "").strip()
        if not key:
            return None
        model = os.getenv("OPENROUTER_MODEL", "").strip() or "openrouter/free"
        return cls(key, model, **kwargs)

    def _log(self, status: str, chars: int, n: int) -> None:
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        row = {"at": datetime.now(timezone.utc).isoformat(), "provider": "openrouter",
               "endpoint": ENDPOINT, "model": self.model, "request_no": n, "prompt_chars": chars,
               "status": status}
        with self.ledger_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")

    def complete_json(self, system: str, user: str, *, max_tokens: int = 1500) -> str:
        """One chat completion expected to be a JSON object. Retries once on 429 or 5xx; each
        attempt counts against the cap."""
        import httpx

        http = self._http or httpx
        body = {
            "model": self.model, "temperature": 0, "max_tokens": max_tokens,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        }
        headers = {"Authorization": f"Bearer {self._key}", "Content-Type": "application/json"}
        last = "no attempt"
        for attempt in range(2):
            n = self.budget.take()  # raises BudgetExceeded before any request is sent
            try:
                resp = http.post(ENDPOINT, json=body, headers=headers, timeout=self.timeout)
            except Exception as exc:  # noqa: BLE001 - network errors are all "failed"
                self._log(f"error:{type(exc).__name__}", len(user), n)
                last = type(exc).__name__
                time.sleep(1.0)
                continue
            self._log(f"http {resp.status_code}", len(user), n)
            if resp.status_code in (429, 500, 502, 503, 504):
                last = f"http {resp.status_code}"
                time.sleep(2.0)
                continue
            if resp.status_code != 200:
                raise LLMCallFailed(f"provider returned http {resp.status_code}")
            try:
                return str(resp.json()["choices"][0]["message"]["content"])
            except (KeyError, IndexError, ValueError, TypeError) as exc:
                raise LLMCallFailed("provider response had no message content") from exc
        raise LLMCallFailed(f"provider request failed after retry ({last})")
