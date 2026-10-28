/**
 * Phase 10B SEC-14: backend traces must never carry resume/JD text, contact details or tokens.
 * Runs real Fastify requests through the tracing hooks with an in-memory exporter.
 */
import Fastify from 'fastify';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  QUEUE_CARRIER_KEY,
  filterAttributes,
  initTelemetry,
  registerTracingHooks,
  shutdownTelemetry,
  withTraceContext,
} from '../telemetry.js';

const CANARIES = [
  'Zyxwq Canaryname',
  'zyxwq.canary@example.com',
  '+1-555-0199-4242',
  'Led the zyxwq-canary migration of seventeen ledgers',
  'zyxwq-secret-internal-token-0123456789abcdef',
  'zyxwq',
];

const exporter = new InMemorySpanExporter();

function dump(): string {
  return exporter
    .getFinishedSpans()
    .map((s) =>
      JSON.stringify({
        name: s.name,
        attributes: s.attributes,
        events: s.events,
        status: s.status,
        resource: s.resource.attributes,
      }),
    )
    .join('\n');
}

describe('telemetry PII safety (SEC-14)', () => {
  beforeAll(() => {
    expect(initTelemetry('resumatch-backend-test', exporter)).toBe(true);
  });

  afterAll(async () => {
    await shutdownTelemetry();
  });

  it('records method, route and status but no query, body, headers or error text', async () => {
    const app = Fastify();
    registerTracingHooks(app);
    let carried: Record<string, unknown> = {};
    app.post('/v1/resumes/:id/complete', async (request) => {
      carried = withTraceContext(request, { resumeId: 'r-1' });
      return { ok: true };
    });
    app.get('/v1/fail', async () => {
      throw new Error('resume of Zyxwq Canaryname zyxwq.canary@example.com failed');
    });
    await app.ready();
    exporter.reset();

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/resumes/abc/complete?email=zyxwq.canary@example.com&name=Zyxwq%20Canaryname',
      payload: { text: 'Led the zyxwq-canary migration of seventeen ledgers', phone: '+1-555-0199-4242' },
      headers: {
        authorization: 'Bearer zyxwq-secret-internal-token-0123456789abcdef',
        cookie: 'session=zyxwq',
        'x-internal-token': 'zyxwq-secret-internal-token-0123456789abcdef',
      },
    });
    expect(ok.statusCode).toBe(200);
    const failed = await app.inject({ method: 'GET', url: '/v1/fail' });
    expect(failed.statusCode).toBe(500);
    await app.close();

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(2);
    const dumped = dump();
    for (const canary of CANARIES) expect(dumped).not.toContain(canary);

    const server = spans.find((s) => s.name === 'POST /v1/resumes/:id/complete');
    expect(server?.attributes['http.route']).toBe('/v1/resumes/:id/complete');
    expect(server?.attributes['http.response.status_code']).toBe(200);
    const error = spans.find((s) => s.name === 'GET /v1/fail');
    expect(error?.attributes['error.type']).toBe('Error');

    // The queue carrier links the Python worker span to this request's trace
    const carrier = carried[QUEUE_CARRIER_KEY] as { traceparent?: string } | undefined;
    expect(carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    expect(carrier?.traceparent?.split('-')[1]).toBe(server?.spanContext().traceId);
  });

  it('stamps trace_id and span_id on every request log line', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const stream = { write: (msg: string) => lines.push(JSON.parse(msg)) };
    const app = Fastify({ logger: { level: 'info', stream } });
    registerTracingHooks(app);
    app.get('/v1/ping', async (request) => {
      request.log.info('handler ran');
      return { ok: true };
    });
    await app.ready();
    exporter.reset();

    await app.inject({ method: 'GET', url: '/v1/ping' });
    await app.close();

    const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /v1/ping');
    const handlerLine = lines.find((l) => l.msg === 'handler ran');
    expect(handlerLine?.trace_id).toBe(span?.spanContext().traceId);
    expect(handlerLine?.span_id).toBe(span?.spanContext().spanId);
    const completed = lines.find((l) => l.msg === 'request completed');
    expect(completed?.trace_id).toBe(span?.spanContext().traceId);
  });

  it('allowlist drops unknown keys and query strings', () => {
    expect(
      filterAttributes({
        'http.route': '/v1/resumes/:id?email=x@y.z',
        'http.request.header.authorization': 'Bearer t',
        'db.statement': "SELECT * FROM users WHERE email='x'",
      }),
    ).toEqual({ 'http.route': '/v1/resumes/:id' });
  });
});

describe('telemetry off by default', () => {
  it('leaves job payloads untouched when tracing is not initialised', async () => {
    await shutdownTelemetry();
    const payload = { resumeId: 'r-1' };
    expect(withTraceContext(undefined, payload)).toBe(payload);
    expect(initTelemetry('x')).toBe(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? true : false);
  });
});
