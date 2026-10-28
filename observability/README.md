# Observability (Phase 10B Workstream B)

Tracing is **off by default**. Turn it on locally with one extra container (`grafana/otel-lgtm`:
OTel Collector, Tempo, Prometheus, Loki and Grafana):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318 docker compose --profile observability up --build
```

Grafana is at http://localhost:3001 (local only; admin / admin on first login), under the
**ResuMatch** folder.

| Dashboard | File | Source |
| :--- | :--- | :--- |
| Service RED (rate, error ratio, p50/p95/p99 per route) | `dashboards/service-red.json` | Tempo span metrics from backend and ml-api server spans |
| ML pipeline stages (worker jobs/s, p95 per stage, failures) | `dashboards/ml-pipeline.json` | Tempo span metrics from `ml.job`, `ml.retrieve.bm25`, `ml.retrieve.vector`, `ml.rerank` |
| LLM usage and cost (tokens/s, USD/h, calls by operation, p95 tokens per call with trace exemplars) | `dashboards/llm-usage.json` | OTel metrics from the ML API's LLM gateway: `gen_ai.client.token.usage`, `resumatch.llm.cost_usd`, `resumatch.llm.calls` |
| Usage meters (metered actions by outcome, share blocked, 50/70/90/100% crossings, refunds by reason) | `dashboards/usage-meters.json` | Backend OTel metrics: `resumatch.usage.consumed`, `resumatch.usage.threshold_crossed`, `resumatch.usage.refunds`. Labels are meter, outcome, threshold and reason only, never a user id |

All 7 LLM-usage panel queries were checked against a live `otel-lgtm` 0.36.0 fed by
`ml/utils/telemetry.py` (Prometheus names: `gen_ai_client_token_usage_*`,
`resumatch_llm_cost_usd_USD_total`, `resumatch_llm_calls_total`).

**Cost is an estimate.** Every configured tier is a free tier, so cost is 0 unless
`LLM_PRICES_JSON` sets per-provider USD per million input/output tokens, for example
`{"groq": [0.59, 0.79]}`. Metric labels are only provider, model, operation, token type and
outcome. Any label value that looks like free text becomes `other`, and a canary test covers
this.

**For load tests**, add the load-test overlay so the ML services keep the mock LLM:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-lgtm:4318 docker compose -f docker-compose.yml -f docker-compose.loadtest.yml --profile observability up -d
```

**Empty RED and ML-pipeline panels right after start are expected.** Those panels read Tempo's
span metrics (`traces_spanmetrics_*`). The series appear about a minute after spans start
flowing, and `rate()` panels need at least two samples. After the container restarts, they
stay empty until traffic arrives. Checked on a live run: steady worker traffic showed
1.78 jobs/s and per-stage p50/p95 matching the generated load.

**Overhead:** measured with k6 at full sampling, with otel-lgtm on the same 4-vCPU host:
- light reads +2–3 ms at p50, p95 roughly doubled but under 100 ms;
- backend CPU +7.6 points;
- no change in worker throughput or errors.

See the "Tracing overhead" section of [docs/PERFORMANCE.md](../docs/PERFORMANCE.md).

## What a trace contains

One request is one trace across services. The backend SERVER span (`POST /v1/jobs/:id/match`)
puts a W3C `traceparent` into the BullMQ job under `_otel`. The worker's `ml.job` span continues
it, with `ml.retrieve.bm25`, `ml.retrieve.vector` and `ml.rerank` as children.
`evidence/trace_backend_to_worker.json` is such a trace, exported from Tempo after sending real
spans through the committed telemetry modules.

No resume text, JD text, contact details, query strings, headers or tokens are ever recorded
(SEC-14 in `docs/SECURITY.md`; canary tests in `backend/src/__tests__/telemetry.pii.test.ts`
and `ml/tests/test_telemetry_pii.py`).

## Logs linked to traces

- **Backend:** pino writes JSON in production, and with tracing on every request log line
  carries `trace_id` and `span_id`, including Fastify's own "request completed" line.
- **ML API and worker:** set `LOG_FORMAT=json` for one JSON object per line with the active
  span's `trace_id` / `span_id` (`ml/utils/logging_setup.py`). The default stays text.

Search a log line's `trace_id` in Tempo to open its trace. Shipping container stdout into Loki
needs a log collector, which the otel-lgtm profile doesn't configure yet.

## Not done yet

- Shipping container stdout into Loki. Logs carry `trace_id`, but no log collector is
  configured in the otel-lgtm profile yet.
