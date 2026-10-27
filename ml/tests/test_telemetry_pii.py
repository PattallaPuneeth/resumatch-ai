"""
Phase 10B SEC-14: telemetry must never export resume text, JD text, contact details or tokens.

Exercises real FastAPI server spans and pipeline stage spans with an in-memory exporter, using
canary strings that must not appear anywhere in the exported spans.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

pytest.importorskip("opentelemetry.sdk")
pytest.importorskip("opentelemetry.instrumentation.fastapi")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import (  # noqa: E402
    InMemorySpanExporter,
)

from ml.utils import telemetry  # noqa: E402

CANARY_NAME = "Zyxwq Canaryname"
CANARY_EMAIL = "zyxwq.canary@example.com"
CANARY_PHONE = "+1-555-0199-4242"
CANARY_SENTENCE = "Led the zyxwq-canary migration of seventeen ledgers"
CANARY_TOKEN = "zyxwq-secret-internal-token-0123456789abcdef"
CANARIES = (CANARY_NAME, CANARY_EMAIL, CANARY_PHONE, CANARY_SENTENCE, CANARY_TOKEN, "zyxwq")


def _dump(spans: Any) -> str:
    """Everything an exporter could send, as one string."""
    parts = []
    for s in spans:
        parts.append(s.name)
        parts.append(json.dumps(dict(s.attributes or {}), default=str))
        for e in s.events:
            parts.append(e.name)
            parts.append(json.dumps(dict(e.attributes or {}), default=str))
        parts.append(str(s.status.description))
        parts.append(json.dumps(dict(s.resource.attributes), default=str))
    return "\n".join(parts)


@pytest.fixture(scope="module")
def exporter() -> InMemorySpanExporter:
    mem = InMemorySpanExporter()
    assert telemetry.init_telemetry("resumatch-ml-test", exporter=mem)
    return mem


def test_http_spans_drop_query_body_and_headers(exporter: InMemorySpanExporter) -> None:
    app = FastAPI()

    @app.post("/v1/echo")
    def echo(payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True}

    telemetry.instrument_fastapi(app)
    client = TestClient(app)
    exporter.clear()

    resp = client.post(
        f"/v1/echo?email={CANARY_EMAIL}&name={CANARY_NAME}",
        json={"resume_text": CANARY_SENTENCE, "phone": CANARY_PHONE},
        headers={"X-Internal-Token": CANARY_TOKEN, "Authorization": f"Bearer {CANARY_TOKEN}"},
    )
    assert resp.status_code == 200

    spans = exporter.get_finished_spans()
    assert spans, "server spans should be exported when telemetry is on"
    dumped = _dump(spans)
    for canary in CANARIES:
        assert canary not in dumped
    # The route is still useful for RED metrics
    assert any(dict(s.attributes or {}).get("http.route") == "/v1/echo" for s in spans)


def test_stage_span_drops_free_text_and_exception_messages(
    exporter: InMemorySpanExporter,
) -> None:
    exporter.clear()
    with telemetry.stage_span("rerank", candidates=20, model="ms-marco-MiniLM-L-6-v2"):
        pass
    with telemetry.stage_span(
        "parse",
        resume_excerpt=CANARY_SENTENCE,
        owner=CANARY_EMAIL,
        contact=CANARY_PHONE,
        resume_id="0b84dcb2-3895-4d8b-a900-926adb751b16",
    ):
        pass
    with pytest.raises(ValueError):
        with telemetry.stage_span("embed"):
            raise ValueError(f"bad resume for {CANARY_NAME} {CANARY_PHONE}")

    spans = exporter.get_finished_spans()
    dumped = _dump(spans)
    for canary in CANARIES:
        assert canary not in dumped

    rerank = next(s for s in spans if s.name == "ml.rerank")
    rerank_attrs = dict(rerank.attributes or {})
    assert rerank_attrs["resumatch.candidates"] == 20
    assert rerank_attrs["resumatch.model"] == "ms-marco-MiniLM-L-6-v2"
    parse = next(s for s in spans if s.name == "ml.parse")
    assert dict(parse.attributes or {}) == {"resumatch.resume_id": "0b84dcb2-3895-4d8b-a900-926adb751b16"}
    failed = next(s for s in spans if s.name == "ml.embed")
    assert dict(failed.attributes or {})["error.type"] == "ValueError"


def test_queue_carrier_joins_backend_trace(exporter: InMemorySpanExporter) -> None:
    exporter.clear()
    trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    carrier = telemetry.queue_carrier(
        {
            "resumeId": "r-1",
            "_otel": {"traceparent": f"00-{trace_id}-00f067aa0ba902b7-01", "x": CANARY_EMAIL},
        }
    )
    assert carrier == {"traceparent": f"00-{trace_id}-00f067aa0ba902b7-01"}
    with telemetry.stage_span("job", carrier=carrier, queue="match-scoring-queue"):
        pass
    (span,) = exporter.get_finished_spans()
    assert format(span.context.trace_id, "032x") == trace_id


def test_filter_attributes_allowlist() -> None:
    cleaned = telemetry.filter_attributes(
        {
            "url.path": "/v1/resumes/abc?email=x@y.z",
            "http.request.header.authorization": "Bearer t",
            "resumatch.resume_id": "8a1f-22",
            "resumatch.note": "free text with spaces",
            "db.statement": "SELECT * FROM parsed_resumes WHERE email='x'",
        }
    )
    assert cleaned == {"url.path": "/v1/resumes/abc", "resumatch.resume_id": "8a1f-22"}
