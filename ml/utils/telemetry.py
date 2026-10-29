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
        "gen_ai.token.type",
        "gen_ai.operation.name",
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
_token_histogram: Any = None
_cost_counter: Any = None
_call_counter: Any = None
_match_score_histogram: Any = None
_match_component_histogram: Any = None
_match_verdict_counter: Any = None
_match_zero_passages_counter: Any = None
_match_passages_histogram: Any = None

# Token-count buckets for gen_ai.client.token.usage (OTel GenAI semantic conventions)
_TOKEN_BUCKETS = (1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144)


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


def _init_metrics(service_name: str, metric_reader: Any = None) -> None:
    """LLM usage metrics. Uses `metric_reader` if given (tests), else OTLP/HTTP every 15 s."""
    global _token_histogram, _cost_counter, _call_counter
    from opentelemetry import metrics
    from opentelemetry.sdk.metrics import Histogram, MeterProvider
    from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
    from opentelemetry.sdk.resources import Resource

    if metric_reader is None:
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        metric_reader = PeriodicExportingMetricReader(
            OTLPMetricExporter(), export_interval_millis=15000
        )
    provider = MeterProvider(
        resource=Resource.create({"service.name": service_name}),
        metric_readers=[metric_reader],
        views=[
            View(
                instrument_type=Histogram,
                instrument_name="gen_ai.client.token.usage",
                aggregation=ExplicitBucketHistogramAggregation(_TOKEN_BUCKETS),
            )
        ],
    )
    metrics.set_meter_provider(provider)
    meter = provider.get_meter("resumatch-ml")
    _token_histogram = meter.create_histogram(
        "gen_ai.client.token.usage", unit="{token}", description="Tokens per LLM call"
    )
    _cost_counter = meter.create_counter(
        "resumatch.llm.cost_usd", unit="USD", description="Estimated LLM spend"
    )
    global _match_score_histogram, _match_component_histogram
    global _match_verdict_counter, _match_zero_passages_counter, _match_passages_histogram
    _call_counter = meter.create_counter(
        "resumatch.llm.calls", unit="{call}", description="LLM calls by provider and outcome"
    )
    _match_score_histogram = meter.create_histogram(
        "resumatch.match.final_score",
        unit="1",
        description="Distribution of final ATS match scores (0-100)",
    )
    _match_component_histogram = meter.create_histogram(
        "resumatch.match.component_score",
        unit="1",
        description="Distribution of match component scores (0-100)",
    )
    _match_verdict_counter = meter.create_counter(
        "resumatch.match.verdict",
        unit="{match}",
        description="Count of match verdicts (strong, medium, weak)",
    )
    _match_zero_passages_counter = meter.create_counter(
        "resumatch.match.zero_passages",
        unit="{match}",
        description="Matches where zero passages were evaluated",
    )
    _match_passages_histogram = meter.create_histogram(
        "resumatch.match.passages",
        unit="{passage}",
        description="Number of evaluated passages per match",
    )


def _label(value: str) -> str:
    """Metric label values follow the resumatch.* rule: enum-like tokens only, else 'other'."""
    digits = sum(ch.isdigit() for ch in value)
    return value if _TOKEN_VALUE.match(value) and digits <= _MAX_TOKEN_DIGITS else "other"


def record_llm_usage(
    provider: str,
    model: str,
    operation: str,
    input_tokens: int,
    output_tokens: int,
    outcome: str = "ok",
    usd_per_mtok: tuple[float, float] = (0.0, 0.0),
) -> None:
    """
    Records one LLM call: token histogram, estimated cost and a call counter. Only provider,
    model, operation, token type and outcome are labels; prompts and responses never are.
    Recorded inside a request span, the histogram carries an exemplar linking to the trace.
    """
    if _token_histogram is None:
        return
    base = {
        "gen_ai.system": _label(provider),
        "gen_ai.request.model": _label(model),
        "gen_ai.operation.name": _label(operation),
    }
    in_tok, out_tok = max(0, int(input_tokens)), max(0, int(output_tokens))
    _token_histogram.record(in_tok, {**base, "gen_ai.token.type": "input"})
    _token_histogram.record(out_tok, {**base, "gen_ai.token.type": "output"})
    cost = (in_tok * usd_per_mtok[0] + out_tok * usd_per_mtok[1]) / 1_000_000
    _cost_counter.add(cost, base)
    _call_counter.add(1, {**base, "resumatch.outcome": _label(outcome)})


def record_match_metrics(
    final_score: float,
    scores: Mapping[str, Any],
    verdict: str,
    passages_count: int,
) -> None:
    """
    Records production monitoring metrics for match calculation:
    score distributions, component scores, verdict mix, and zero-passage match counts.
    """
    if _match_score_histogram is None:
        return

    v_label = _label(verdict)
    _match_score_histogram.record(float(final_score), {"resumatch.verdict": v_label})
    _match_verdict_counter.add(1, {"resumatch.verdict": v_label})

    _match_passages_histogram.record(int(passages_count))
    if passages_count == 0:
        _match_zero_passages_counter.add(1)

    if "best_ce_score" in scores:
        _match_component_histogram.record(
            float(scores["best_ce_score"]), {"resumatch.component": "cross_encoder"}
        )
    if "best_vector" in scores:
        _match_component_histogram.record(
            float(scores["best_vector"] * 100.0), {"resumatch.component": "vector"}
        )
    if "best_bm25" in scores:
        _match_component_histogram.record(
            float(scores["best_bm25"]), {"resumatch.component": "bm25"}
        )
    if scores.get("skill_coverage") is not None:
        _match_component_histogram.record(
            float(scores["skill_coverage"] * 100.0), {"resumatch.component": "skill_coverage"}
        )


def init_telemetry(service_name: str, exporter: Any = None, metric_reader: Any = None) -> bool:
    """
    Enables tracing and LLM usage metrics for this process. Uses `exporter` / `metric_reader`
    if given (tests pass in-memory ones), else OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is
    set. Returns True if on.
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
    if metric_reader is not None or exporter is None:
        try:
            _init_metrics(service_name, metric_reader)
        except ImportError:
            logger.warning("opentelemetry metrics SDK missing; LLM usage metrics off")
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
