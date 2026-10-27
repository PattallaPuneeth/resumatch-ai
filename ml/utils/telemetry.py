"""
Phase 10B Workstream B: OpenTelemetry tracing for the ML API and worker.

Off by default. Tracing turns on only when OTEL_EXPORTER_OTLP_ENDPOINT is set and the
opentelemetry packages are importable; otherwise every helper here is a cheap no-op, so
local runs and tests behave exactly as before.

PII safety (SEC-14): spans never carry resume text, JD text, prompts, emails or tokens.
Every exported span passes through AllowlistSpanExporter, which keeps only allowlisted
attribute keys, drops query strings from URLs, keeps only `exception.type` on events and
replaces the status description. Stage helpers only accept counts, ids, model names and
outcomes; anything else is dropped before export.
"""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger("resumatch-ml-telemetry")

# Attribute keys that may leave the process. Everything else is dropped at export time.
ALLOWED_ATTRIBUTE_KEYS: frozenset[str] = frozenset(
    {
        "http.request.method",
        "http.method",
        "http.response.status_code",
        "http.status_code",
        "http.route",
        "http.scheme",
        "url.scheme",
        "url.path",
        "network.protocol.version",
        "server.address",
        "server.port",
        "error.type",
        "exception.type",
        "gen_ai.system",
        "gen_ai.request.model",
        "gen_ai.usage.input_tokens",
        "gen_ai.usage.output_tokens",
        "messaging.system",
        "messaging.destination.name",
        "db.system",
    }
)
# resumatch.* attributes are written only through stage_span(), which is itself allowlisted.
ALLOWED_ATTRIBUTE_PREFIXES: tuple[str, ...] = ("resumatch.",)

# resumatch.* string values must look like a UUID, model name or enum: no spaces (so no free
# text), no "@" (no emails) and at most 6 digits unless it is a UUID (no phone numbers).
_TOKEN_VALUE = re.compile(r"^[A-Za-z0-9_.:/-]{1,64}$")
_UUID_VALUE = re.compile(r"^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$", re.IGNORECASE)
_MAX_TOKEN_DIGITS = 6
_MAX_ATTRIBUTE_STRING = 64

QUEUE_CARRIER_KEY = "_otel"

_tracer: Any = None
_enabled = False


def is_enabled() -> bool:
    return _enabled


def _allowed(key: str) -> bool:
    return key in ALLOWED_ATTRIBUTE_KEYS or key.startswith(ALLOWED_ATTRIBUTE_PREFIXES)


def _clean_value(key: str, value: Any) -> Any:
    """Returns the exportable form of an allowlisted attribute, or None to drop it."""
    if isinstance(value, bool | int | float):
        return value
    if not isinstance(value, str):
        return None
    if key in ("url.path", "http.route"):
        value = value.split("?", 1)[0]
    if key.startswith(ALLOWED_ATTRIBUTE_PREFIXES):
        if _UUID_VALUE.match(value):
            return value
        digits = sum(ch.isdigit() for ch in value)
        return value if _TOKEN_VALUE.match(value) and digits <= _MAX_TOKEN_DIGITS else None
    return value[:_MAX_ATTRIBUTE_STRING]


def filter_attributes(attributes: Mapping[str, Any] | None) -> dict[str, Any]:
    """Returns only allowlisted attributes, with query strings removed and free text dropped."""
    if not attributes:
        return {}
    cleaned: dict[str, Any] = {}
    for key, value in attributes.items():
        if not _allowed(key):
            continue
        safe = _clean_value(key, value)
        if safe is not None:
            cleaned[key] = safe
    return cleaned


def _build_allowlist_exporter(inner: Any) -> Any:
    from opentelemetry.sdk.trace import Event, ReadableSpan
    from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
    from opentelemetry.trace import Status

    class AllowlistSpanExporter(SpanExporter):
        """Re-creates every span with only allowlisted, PII-free fields before export."""

        def __init__(self, delegate: Any) -> None:
            self._delegate = delegate

        def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
            cleaned = []
            for span in spans:
                events = [
                    Event(
                        name=e.name,
                        attributes=(
                            {"exception.type": e.attributes["exception.type"]}
                            if e.attributes and "exception.type" in e.attributes
                            else {}
                        ),
                        timestamp=e.timestamp,
                    )
                    for e in span.events
                ]
                cleaned.append(
                    ReadableSpan(
                        name=span.name,
                        context=span.context,
                        parent=span.parent,
                        resource=span.resource,
                        attributes=filter_attributes(span.attributes),
                        events=events,
                        links=span.links,
                        kind=span.kind,
                        status=Status(span.status.status_code),
                        start_time=span.start_time,
                        end_time=span.end_time,
                        instrumentation_scope=span.instrumentation_scope,
                    )
                )
            result: SpanExportResult = self._delegate.export(cleaned)
            return result

        def shutdown(self) -> None:
            self._delegate.shutdown()

        def force_flush(self, timeout_millis: int = 30000) -> bool:
            return bool(self._delegate.force_flush(timeout_millis))

    return AllowlistSpanExporter(inner)


def init_telemetry(service_name: str, exporter: Any = None) -> bool:
    """
    Enables tracing for this process. Uses `exporter` if given (tests pass an in-memory
    exporter), else OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set. Returns True if on.
    """
    global _tracer, _enabled
    if exporter is None and not os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"):
        return False
    try:
        from opentelemetry import trace
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
        from opentelemetry.sdk.trace.sampling import ParentBased, TraceIdRatioBased
    except ImportError:
        logger.warning("OTEL endpoint set but opentelemetry packages are missing; tracing off")
        return False

    ratio = float(os.environ.get("OTEL_TRACES_SAMPLER_ARG", "1.0"))
    provider = TracerProvider(
        resource=Resource.create({"service.name": service_name}),
        sampler=ParentBased(TraceIdRatioBased(ratio)),
    )
    if exporter is not None:
        provider.add_span_processor(SimpleSpanProcessor(_build_allowlist_exporter(exporter)))
    else:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

        provider.add_span_processor(
            BatchSpanProcessor(_build_allowlist_exporter(OTLPSpanExporter()))
        )
    trace.set_tracer_provider(provider)
    _tracer = provider.get_tracer("resumatch-ml")
    _enabled = True
    logger.info("OpenTelemetry tracing enabled for %s (sample ratio %.2f)", service_name, ratio)
    return True


def instrument_fastapi(app: Any) -> None:
    """Adds server spans for every request. Headers and bodies are never captured."""
    if not _enabled:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    except ImportError:
        logger.warning("opentelemetry-instrumentation-fastapi missing; no HTTP server spans")
        return
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health")


@contextmanager
def stage_span(
    name: str,
    carrier: Mapping[str, Any] | None = None,
    **attributes: str | int | float | bool | None,
) -> Iterator[Any]:
    """
    Span for one pipeline stage (`parse`, `embed`, `retrieve.bm25`, `rerank`, ...).
    Attributes are written as `resumatch.<key>`; pass only ids, counts, scores and outcomes.
    `carrier` is a W3C trace-context dict (e.g. job.data["_otel"] from the backend) that makes
    this span a child of the request that enqueued the job.
    """
    if not _enabled or _tracer is None:
        yield None
        return
    from opentelemetry.propagate import extract
    from opentelemetry.trace import Status, StatusCode

    ctx = extract(dict(carrier)) if carrier else None
    with _tracer.start_as_current_span(f"ml.{name}", context=ctx) as span:
        for key, value in filter_attributes(
            {f"resumatch.{k}": v for k, v in attributes.items() if v is not None}
        ).items():
            span.set_attribute(key, value)
        try:
            yield span
        except Exception as exc:
            span.set_attribute("error.type", type(exc).__name__)
            span.set_status(Status(StatusCode.ERROR))
            raise


def queue_carrier(job_data: Mapping[str, Any] | None) -> dict[str, str] | None:
    """Returns the trace-context carrier the backend put in a BullMQ job, if any."""
    if not job_data:
        return None
    raw = job_data.get(QUEUE_CARRIER_KEY)
    if not isinstance(raw, Mapping):
        return None
    return {str(k): str(v) for k, v in raw.items() if k in ("traceparent", "tracestate")}
