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

All 7 LLM-usage panel queries were checked against a live `otel-lgtm` 0.36.0 fed by
`ml/utils/telemetry.py` (Prometheus names: `gen_ai_client_token_usage_*`,
`resumatch_llm_cost_usd_USD_total`, `resumatch_llm_calls_total`).

**Cost is an estimate.** Every configured tier is a free tier, so cost is 0 unless
`LLM_PRICES_JSON` sets per-provider USD per million input/output tokens, for example
`{"groq": [0.59, 0.79]}`. Metric labels are only provider, model, operation, token type and
outcome. Any label value that looks like free text becomes `other`, and a canary test covers
this.

## What a trace contains

One request is one trace across services. The backend SERVER span (`POST /v1/jobs/:id/match`)
puts a W3C `traceparent` into the BullMQ job under `_otel`. The worker's `ml.job` span continues
it, with `ml.retrieve.bm25`, `ml.retrieve.vector` and `ml.rerank` as children.
`evidence/trace_backend_to_worker.json` is such a trace, exported from Tempo after sending real
spans through the committed telemetry modules.

No resume text, JD text, contact details, query strings, headers or tokens are ever recorded
(SEC-14 in `docs/SECURITY.md`; canary tests in `backend/src/__tests__/telemetry.pii.test.ts`
and `ml/tests/test_telemetry_pii.py`).

## Not done yet

- Usage-meter threshold counters (per-user analysis quota) aren't emitted as metrics yet.
- Overhead measurement: rerun the k6 `match` and `mixed` scenarios with tracing on and
  compare against the baselines in `docs/PERFORMANCE.md`.
- Structured JSON logs with `trace_id` / `span_id`.
