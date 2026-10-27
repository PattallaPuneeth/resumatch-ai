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

- LLM token/cost and usage-meter dashboards: the code doesn't emit those metrics yet
  (`gen_ai.client.token.usage`, `resumatch.llm.cost_usd`, meter threshold counters).
- Overhead measurement: rerun the k6 `match` and `mixed` scenarios with tracing on and
  compare against the baselines in `docs/PERFORMANCE.md`.
- Structured JSON logs with `trace_id` / `span_id`.
