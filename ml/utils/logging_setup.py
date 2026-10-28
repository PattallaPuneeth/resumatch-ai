"""
Process-wide logging for the ML API and worker.

LOG_FORMAT=json writes one JSON object per line with `trace_id` and `span_id` taken from the
active OpenTelemetry span, so a log line in Loki links to its trace in Tempo. The default
(text) keeps the existing human-readable format. Messages are logged as written: the SEC-01
rule that resume text never reaches a log statement still applies at each call site.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

TEXT_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"


def _trace_ids() -> dict[str, str]:
    try:
        from opentelemetry import trace
    except ImportError:
        return {}
    ctx = trace.get_current_span().get_span_context()
    if not ctx.is_valid:
        return {}
    return {"trace_id": format(ctx.trace_id, "032x"), "span_id": format(ctx.span_id, "016x")}


class JsonFormatter(logging.Formatter):
    """One JSON object per record: time, level, logger, message, service, trace ids."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "service": self.service,
        }
        entry.update(_trace_ids())
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def configure_logging(service: str, level: str | None = None) -> None:
    """Sets the root handler once per process. LOG_FORMAT picks json or text."""
    handler = logging.StreamHandler()
    if os.environ.get("LOG_FORMAT", "text").strip().lower() == "json":
        handler.setFormatter(JsonFormatter(service))
    else:
        handler.setFormatter(logging.Formatter(TEXT_FORMAT))
    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel((level or os.environ.get("LOG_LEVEL") or "info").upper())
