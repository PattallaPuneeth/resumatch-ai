/**
 * Phase 10B Workstream B: OpenTelemetry tracing for the Fastify backend.
 *
 * Off by default: tracing starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set (or a test
 * passes an exporter), so local runs and the vitest suite behave exactly as before.
 *
 * Spans are created by Fastify hooks (one SERVER span per request) instead of monkey-patched
 * auto-instrumentation, so only fields we choose are recorded: method, route template,
 * status code, error type. Query strings, bodies, headers and cookies are never attached,
 * and an allowlist exporter strips anything else before export (SEC-14).
 *
 * Queue propagation: withTraceContext() adds a W3C `traceparent` carrier to a BullMQ job
 * payload under `_otel`; the Python worker extracts it so ingestion and matching appear as
 * one trace across Node, BullMQ and Python.
 */
import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Counter,
  type Span,
} from '@opentelemetry/api';
import type { ExportResult } from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export const QUEUE_CARRIER_KEY = '_otel';

const ALLOWED_ATTRIBUTE_KEYS = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'url.scheme',
  'error.type',
  'exception.type',
  'messaging.system',
  'messaging.destination.name',
]);

let enabled = false;
let provider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let usageConsumed: Counter | undefined;
let usageThresholds: Counter | undefined;
let usageRefunds: Counter | undefined;

const USAGE_THRESHOLDS = [50, 70, 90, 100] as const;
const requestSpans = new WeakMap<FastifyRequest, Span>();

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function filterAttributes(attributes: Attributes | undefined): Attributes {
  const out: Attributes = {};
  if (!attributes) return out;
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALLOWED_ATTRIBUTE_KEYS.has(key) || value === undefined) continue;
    out[key] = typeof value === 'string' ? value.split('?', 1)[0].slice(0, 128) : value;
  }
  return out;
}

/** Wraps an exporter so every span leaves with allowlisted attributes and PII-free events. */
class AllowlistSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const cleaned = spans.map((span) =>
      // Keep the span as prototype so methods such as spanContext() still work for exporters
      Object.create(span, {
        attributes: { value: filterAttributes(span.attributes) },
        events: {
          value: span.events.map((e) => ({
            name: e.name,
            time: e.time,
            attributes:
              e.attributes && e.attributes['exception.type'] !== undefined
                ? { 'exception.type': e.attributes['exception.type'] }
                : {},
          })),
        },
        status: { value: { code: span.status.code } },
      }) as ReadableSpan,
    );
    this.delegate.export(cleaned, resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush ? this.delegate.forceFlush() : Promise.resolve();
  }
}

/**
 * Starts tracing for this process. Uses `exporter` when given (tests pass an in-memory
 * exporter), otherwise OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set. Returns true if on.
 */
export function initTelemetry(
  serviceName: string,
  exporter?: SpanExporter,
  metricReader?: MetricReader,
): boolean {
  if (!exporter && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  if (enabled) return true;

  const ratio = Number(process.env.OTEL_TRACES_SAMPLER_ARG ?? '1');
  const inner = new AllowlistSpanExporter(exporter ?? new OTLPTraceExporter());
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 1),
    }),
    spanProcessors: [exporter ? new SimpleSpanProcessor(inner) : new BatchSpanProcessor(inner)],
  });
  provider.register();
  // Usage metrics go to OTLP in real runs; tests pass an in-memory reader or none
  const reader =
    metricReader ??
    (exporter
      ? undefined
      : new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 15000 }));
  if (reader) {
    meterProvider = new MeterProvider({
      resource: resourceFromAttributes({ 'service.name': serviceName }),
      readers: [reader],
    });
    const meter = meterProvider.getMeter('resumatch-backend');
    usageConsumed = meter.createCounter('resumatch.usage.consumed', {
      description: 'Metered actions by meter and outcome (allowed or blocked)',
    });
    usageThresholds = meter.createCounter('resumatch.usage.threshold_crossed', {
      description: 'Times a user crossed 50/70/90/100% of a monthly meter',
    });
    usageRefunds = meter.createCounter('resumatch.usage.refunds', {
      description: 'Meter refunds by reason',
    });
  }
  enabled = true;
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  if (meterProvider) {
    await meterProvider.shutdown().catch(() => {});
    meterProvider = undefined;
    usageConsumed = usageThresholds = usageRefunds = undefined;
  }
  if (!provider) return;
  await provider.shutdown().catch(() => {});
  provider = undefined;
  enabled = false;
}

/**
 * Records one meter consume. Labels are fixed enums only (meter, outcome, threshold): never a
 * user id. Threshold counters fire when this consume moved usage across 50/70/90/100%.
 */
export function recordUsageConsume(
  meter: string,
  allowed: boolean,
  usedAfter: number,
  amount: number,
  limit: number | null,
): void {
  if (!usageConsumed) return;
  usageConsumed.add(1, { meter, outcome: allowed ? 'allowed' : 'blocked' });
  if (!allowed || !usageThresholds || limit === null || limit <= 0) return;
  const before = usedAfter - amount;
  for (const t of USAGE_THRESHOLDS) {
    if (before * 100 < limit * t && usedAfter * 100 >= limit * t) {
      usageThresholds.add(1, { meter, threshold: String(t) });
    }
  }
}

/** Records a refund: 'downstream_error' (5xx/timeout) or 'verification' (rejected output). */
export function recordUsageRefund(meter: string, reason: 'downstream_error' | 'verification'): void {
  usageRefunds?.add(1, { meter, reason });
}

/** One SERVER span per request: method, route template and status code only. */
export function registerTracingHooks(app: FastifyInstance): void {
  if (!enabled) return;
  const tracer = trace.getTracer('resumatch-backend');

  app.addHook('onRequest', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    // Only the trace-context headers are read from the caller, never other headers
    const carrier: Record<string, string> = {};
    const tp = request.headers.traceparent;
    if (typeof tp === 'string') carrier.traceparent = tp;
    const parent = propagation.extract(context.active(), carrier);
    const span = tracer.startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.request.method': request.method, 'http.route': route },
      },
      parent,
    );
    requestSpans.set(request, span);
    // Every log line for this request carries the IDs, so a log jumps straight to its trace
    const { traceId, spanId } = span.spanContext();
    const ids = { trace_id: traceId, span_id: spanId };
    request.log = request.log.child(ids);
    reply.log = reply.log.child(ids);
  });

  app.addHook('onError', async (request, _reply, error) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('error.type', error.name || 'Error');
    span.setStatus({ code: SpanStatusCode.ERROR });
  });

  app.addHook('onResponse', async (request, reply) => {
    const span = requestSpans.get(request);
    if (!span) return;
    span.setAttribute('http.response.status_code', reply.statusCode);
    if (reply.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    requestSpans.delete(request);
  });
}

/**
 * Returns the job payload with a `_otel` W3C trace-context carrier when tracing is on, so the
 * Python worker's span joins this request's trace. Returns the payload unchanged when off.
 */
export function withTraceContext<T extends object>(
  request: FastifyRequest | undefined,
  payload: T,
): T {
  if (!enabled || !request) return payload;
  const span = requestSpans.get(request);
  if (!span) return payload;
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(context.active(), span), carrier);
  if (!carrier.traceparent) return payload;
  return { ...payload, [QUEUE_CARRIER_KEY]: carrier };
}
