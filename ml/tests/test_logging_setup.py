"""JSON logs carry the active span's trace_id/span_id; text stays the default."""

from __future__ import annotations

import io
import json
import logging

import pytest

from ml.utils.logging_setup import TEXT_FORMAT, JsonFormatter, configure_logging


def _capture(formatter: logging.Formatter) -> tuple[logging.Logger, io.StringIO]:
    buf = io.StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(formatter)
    log = logging.getLogger(f"test-logging-{id(buf)}")
    log.handlers = [handler]
    log.propagate = False
    log.setLevel(logging.INFO)
    return log, buf


def test_json_line_has_trace_ids_inside_a_span() -> None:
    sdk = pytest.importorskip("opentelemetry.sdk.trace")
    tracer = sdk.TracerProvider().get_tracer("test")
    log, buf = _capture(JsonFormatter("resumatch-ml-worker"))

    with tracer.start_as_current_span("ml.rerank") as span:
        log.info("reranked %d candidates", 5)
        ctx = span.get_span_context()

    entry = json.loads(buf.getvalue())
    assert entry["msg"] == "reranked 5 candidates"
    assert entry["level"] == "info"
    assert entry["service"] == "resumatch-ml-worker"
    assert entry["trace_id"] == format(ctx.trace_id, "032x")
    assert entry["span_id"] == format(ctx.span_id, "016x")


def test_json_line_outside_a_span_has_no_ids() -> None:
    log, buf = _capture(JsonFormatter("resumatch-ml-api"))
    log.warning("no span here")
    entry = json.loads(buf.getvalue())
    assert "trace_id" not in entry and entry["level"] == "warning"


def test_exceptions_are_kept_as_one_json_line() -> None:
    log, buf = _capture(JsonFormatter("resumatch-ml-api"))
    try:
        raise ValueError("boom")
    except ValueError:
        log.exception("failed")
    lines = buf.getvalue().strip().splitlines()
    assert len(lines) == 1
    assert "ValueError" in json.loads(lines[0])["exc"]


def test_text_is_the_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    root = logging.getLogger()
    saved = (root.handlers[:], root.level)
    try:
        configure_logging("svc")
        fmt = root.handlers[0].formatter
        assert fmt is not None and fmt._fmt == TEXT_FORMAT
        monkeypatch.setenv("LOG_FORMAT", "json")
        configure_logging("svc")
        assert isinstance(root.handlers[0].formatter, JsonFormatter)
    finally:
        root.handlers = saved[0]
        root.setLevel(saved[1])
