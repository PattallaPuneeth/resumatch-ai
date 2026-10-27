# Phase 10B Plan: Load Testing, OpenTelemetry, Production Deployment & Documentation

**Status:** PLANNED, not started. Nothing below is implemented yet.
**Depends on:** Phase 10A (COMPLETE & VERIFIED).
**Governing docs:** `docs/SPECIFICATION.md` §6 (Phase 5 benchmarks), §7.3 (Render), §7.4 (ML memory); `docs/RULE.md`; `docs/ROADMAP.md` §11.

---

## 0. Repository facts this plan builds on

Checked on 2026-10-27 at commit `24d4664`:

| Area | Current state | What it means for 10B |
|---|---|---|
| Local stack | `docker-compose.yml` already brings up postgres, redis, minio, migrate, backend, ml, ml-worker, frontend with health checks and ordering | "One-command compose" mostly exists; 10B adds a `.env` bootstrap, a health-check command, and an observability profile |
| Rate limits | `@fastify/rate-limit`, keyed by IP (no `keyGenerator`); upload-url 10/min, jobs/match/analysis 20/min | k6 from one IP hits 429s almost at once. Load tests need a guarded override (see 1.3) |
| Upload flow | Presigned PUT straight to S3 (`s3SignerClient` always `forcePathStyle: true`), then `POST /v1/resumes/:id/complete`, then a BullMQ job to `ml-worker` | k6 has to do the 3-step flow and poll status to measure real ingestion latency |
| LLM gateway | `ml/pipelines/llm/config.py` hard-codes provider `base_url`s; tokens are already saved (`tokensPrompt`, `tokensCompletion`) | Load tests must never reach a real provider (RULE S2). We need a local mock-LLM base-URL override. Token data for dashboards already exists |
| Logging | Node: pino (pretty in dev). Python: `logging.basicConfig` plain text | Python needs JSON logs with trace IDs |
| Telemetry | None | Built from nothing |
| Storage | Endpoint, region, and path-style are already env-driven in `backend/src/storage/s3.ts` and `ml/storage/s3.py` | R2 should be config only, apart from the signer's forced path-style (check it against R2) |
| README | Out of date (describes a Vite frontend and "Phase 1" endpoints) | Full rewrite |
| ML memory | Spec records worker idle around 160 MiB and peak around 523 MiB (embedding only); OCR peaks not measured | Do the §7.4 measurement matrix before choosing Render instance sizes |

---

## 1. Workstream A: k6 load testing and capacity measurement

**Goal:** real p50/p95/p99 latency, throughput, and error rate for upload/ingestion, match, and analysis on a documented environment. Report the actual numbers even if they miss targets (SPEC §6: text PDF ingestion p95 < 3.5 s, OCR p95 < 8 s).

### 1.1 Layout
```
loadtest/
  k6/
    lib/            auth.js, upload.js, checks.js, data.js
    scenarios/      smoke.js, ingestion.js, match.js, analysis.js, mixed.js, soak.js
    fixtures/       text_1p.pdf, docx_1p.docx, scan_1p.pdf, scan_5p.pdf, jd_*.json (synthetic, no real PII)
  seed/             seedLoadUsers.ts (creates N test users + jobs; prints nothing secret)
  results/          <date>_<scenario>.json + summary.md (committed evidence)
  README.md         how to run, environment spec, how to read results
```
k6 runs from the pinned `grafana/k6` Docker image (`docker run --network resumatch-network ...`), so no host install is needed.

### 1.2 Scenarios
| Scenario | Flow | Executor | Thresholds (pass/fail gates) |
|---|---|---|---|
| `smoke` | login, upload-url, PUT, complete, poll until PARSED, match, analysis | 1 VU, 1 iteration | 0 errors, all checks pass |
| `ingestion` | 3-step upload, then poll `GET /v1/resumes/:id` until a terminal status; time from upload start to PARSED/EMBEDDED as a custom `ingestion_e2e` Trend, tagged by file type | `ramping-arrival-rate` 0.2 to 2 uploads/s | `ingestion_e2e{type:text}` p95 < 3500 ms, `{type:ocr}` p95 < 8000 ms, error rate < 1% |
| `match` | `POST /v1/jobs/:id/match` against seeded resumes | `constant-arrival-rate`, stepped (5, 10, 20 rps) | p95 recorded per step; error rate < 1% |
| `analysis` | `POST /v1/jobs/:id/analysis` with the **mock LLM** (fixed 800 ms latency, valid grounded JSON) | low rate (1 to 3 rps) | records ML + gateway overhead without provider latency |
| `mixed` | realistic weights: 10% upload, 50% read/list, 30% match, 10% analysis | ramp to saturation | finds the knee: the rps where p95 or errors climb |
| `soak` | `mixed` at 60% of the knee for 30 min | constant | no memory growth trend, no DLQ growth, no stuck `PROCESSING` rows |

Idempotency check under load: some upload/complete and analysis requests are replayed with the same `Idempotency-Key`. Assert `X-Idempotency-Replay: true` and that usage meters grow exactly once (query `/v1/usage` before and after).

### 1.3 Rate limits during load tests (needs a decision)
Keyed by IP, one k6 host can make only 10 uploads a minute. Proposal:
- Add `RATE_LIMIT_MULTIPLIER` (default `1`) to `env.ts`, read by every route's `rateLimit.max`.
- **Hard guard:** Zod refusal at boot if `RATE_LIMIT_MULTIPLIER != 1` and `NODE_ENV=production` without `LOADTEST_ALLOW=true`. Production `render.yaml` never sets either variable.
- Unit test covers the guard. A separate k6 run with the multiplier at `1` proves 429s still fire (the limiter is part of the system under test, not something we bypass for good numbers).

### 1.4 Mock LLM (RULE S2 safety)
- Add a `LLM_BASE_URL_OVERRIDE` env var to `ml/pipelines/llm/config.py`. When set, every tier points at it. Rejected at startup if the value is not `http://mock-llm:*` / `localhost` while `ENV=production`.
- `loadtest/mock-llm/` holds a small FastAPI OpenAI-compatible stub (`/chat/completions`) that returns schema-valid, grounded JSON built from the request, with configurable latency and error injection (`MOCK_LLM_FAIL_RATE`) to exercise tier failover.
- It lives under a compose profile `loadtest`, so normal `docker compose up` never starts it.
- **Zero real provider calls during any load test.** Before each run, check by grepping `docker compose logs` for provider hostnames (RULE S4 ledger).

### 1.5 ML memory matrix (SPEC §7.4)
Script `loadtest/memory/measure.ps1` (plus a `.sh` twin) samples `docker stats --no-stream` every 500 ms for `ml` and `ml-worker` while processing one of each: text PDF, DOCX, 1-page scan, 5-page scan, 5 MB image-heavy PDF. It records idle-after-model-load, peak, and post-job RSS, and runs with the current 2 GB limit, then 1 GB.
Output: `docs/eval/ml_memory.md`. The result **decides the Render instance size** (Workstream C).

### 1.6 Environment documentation
Every results file records: host CPU and RAM, Docker Desktop limits, commit SHA, compose override used, LLM mode (mock), dataset, and k6 version. Results only count as evidence when they come from a committed script run against a clean stack.

### 1.7 Deliverables and acceptance
- [x] `loadtest/` harness, mock LLM, `docker-compose.loadtest.yml` overlay, `loadtest/run.sh` with provider ledger (users are created and deleted inside each k6 run, so no separate seed script)
- [x] Guarded `RATE_LIMIT_MULTIPLIER` (6 vitest tests) and `LLM_BASE_URL_OVERRIDE` (11 pytest tests)
- [x] Baseline results in `loadtest/results/` + `docs/PERFORMANCE.md` (per-scenario tables, SPEC §6 target vs actual, root cause of the worker stalls)
- [x] ML memory matrix (in `docs/PERFORMANCE.md` §ML memory rather than a separate `docs/eval/ml_memory.md`)
- [ ] CI `k6-smoke` job: **deferred until the 10B-3 worker fix.** On a cold worker the smoke fails every time because of Finding 1, so adding it now would only make CI red.

---

## 2. Workstream B: OpenTelemetry, metrics, and structured logs

**Goal:** one trace that follows a request through browser, Fastify, Postgres/Redis/S3, BullMQ, the Python worker, Postgres, and the LLM call. Add RED metrics and token/cost metrics. Logs get correlation IDs. **No resume text, JD text, prompts, or PII in any span, metric label, or log.**

### 2.1 Node (backend)
- Dependencies: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node` (http, fastify, ioredis, pg; `@prisma/instrumentation` for Prisma), `@opentelemetry/exporter-trace-otlp-http`, `exporter-metrics-otlp-http`.
- `backend/src/telemetry.ts` loads via `node --import` before the app. Off when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset (zero overhead locally and in tests).
- **Queue propagation:** when enqueueing a BullMQ job, inject W3C `traceparent` into `job.data._otel`. The Python worker extracts it, so ingestion appears as one trace.
- pino: add `trace_id` / `span_id` to every log line with the pino instrumentation. Keep the existing redaction paths.
- Custom metrics: `resumatch.ingestion.duration` (histogram, attrs: file_type, outcome), `resumatch.queue.depth` / `resumatch.dlq.depth` (observable gauges polled from BullMQ), `resumatch.idempotency.replays`, `resumatch.meter.threshold_crossed{threshold=50|70|90}`.

### 2.2 Python (ml, ml-worker)
- Dependencies: `opentelemetry-sdk`, `opentelemetry-exporter-otlp-proto-http`, `opentelemetry-instrumentation-fastapi`, `-httpx`, `-psycopg`, `-redis` (pinned in `requirements.txt`).
- Manual spans around each pipeline stage: `parse`, `ocr`, `chunk`, `embed`, `retrieve.bm25`, `retrieve.vector`, `rrf`, `rerank`, `llm.gateway`, `llm.tier_attempt`, `grounding.verify`.
- LLM spans follow the OTel GenAI semantic conventions: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, plus `resumatch.llm.tier`, `resumatch.llm.outcome` (ok, schema_fail, grounding_fail, http_error). No prompt or completion content.
- Metrics: `gen_ai.client.token.usage` (histogram, by provider/model/type), `resumatch.llm.cost_usd` (counter, from a versioned price table in `ml/pipelines/llm/pricing.py`; free models are recorded as `0` and the table shows when the prices were last checked), `resumatch.llm.failover` (counter).
- JSON logging: replace `basicConfig` with a JSON formatter carrying `trace_id`, `span_id`, `service`, `level`, `event`. A shared `ml/utils/logging.py` serves both API and worker.

### 2.3 PII safety (security gate)
- A span processor allowlists attribute keys and drops or truncates everything else. HTTP bodies are never captured, query strings are stripped, and the `Authorization`, `Cookie`, and `X-Internal-Token` headers are never recorded.
- Tests (Node vitest + pytest) use the **in-memory span exporter**: run an upload and an analysis with a fixture resume holding unique canary strings (name, email, phone, a sentence), then assert no exported span, attribute, event, or log line contains any canary.
- Add the findings and disposition to `docs/SECURITY.md` (new SEC-14 "Telemetry data exposure").

### 2.4 Backends and dashboards
- **Local:** one `grafana/otel-lgtm` container (OTel Collector, Tempo, Prometheus/Mimir, Loki, Grafana) under the compose profile `observability`. One container, not five, per RULE "avoid unnecessary complexity".
- **Production:** OTLP over HTTPS to a hosted backend (decision D2), set with `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS` as Render secrets.
- Committed dashboards as JSON in `observability/dashboards/`:
  1. **Service RED:** rate, errors, and p50/p95/p99 duration per route and per ML endpoint
  2. **Ingestion pipeline:** stage durations, queue depth, DLQ depth, OCR share
  3. **LLM cost and tokens:** tokens per provider/model per day, cost, failover rate, schema/grounding failure rate
  4. **Usage meters:** 50/70/90 threshold crossings
- Sampling: parent-based, 100% locally; production defaults to `OTEL_TRACES_SAMPLER_ARG=0.2` and always keeps error traces.

### 2.5 Overhead measurement
Re-run the `match` and `mixed` k6 scenarios with telemetry on and compare against the Workstream A baseline. Report the p95 delta in `docs/PERFORMANCE.md` as measured, not assumed.

### 2.6 Deliverables and acceptance
- [ ] One trace for upload through PARSED/EMBEDDED, crossing Node, BullMQ, and Python (screenshot + exported trace JSON as evidence)
- [ ] One trace for analysis showing tier attempts and token counts
- [ ] PII canary tests pass in both stacks; SEC-14 recorded
- [ ] 4 dashboards committed and shown filled with data from a k6 run
- [ ] Telemetry fully off when no endpoint is set (tests run unchanged)
- [ ] Overhead delta recorded

---

## 3. Workstream C: Production deployment (Render + R2)

**Goal:** a reproducible `render.yaml` blueprint that meets SPEC §7.3, deploys behind real HTTPS, and passes a production smoke test.

### 3.1 Service topology
| Service | Render type | Image/command | Network | Notes |
|---|---|---|---|---|
| `resumatch-frontend` | Web Service (Docker) | `frontend/Dockerfile` | public | `NEXT_PUBLIC_API_URL` passed as a **build arg** (inlined at build) |
| `resumatch-backend` | Web Service (Docker) | `backend/Dockerfile` | public | `preDeployCommand: npx prisma migrate deploy` (check the plan supports it; otherwise a one-off job) |
| `resumatch-ml` | **Private Service** (Docker) | `ml/Dockerfile`, uvicorn | private only | never public (SPEC §7.3); reached at `http://resumatch-ml:8000` |
| `resumatch-ml-worker` | Background Worker (Docker) | same ML image, `python -m ml.worker` | private | instance size from §1.5 measurements; **not** a 512 MB tier |
| Postgres | Render Postgres 16 | n/a | private | `CREATE EXTENSION vector` is already in migrations; check pgvector is available on the plan |
| Key Value | Render Key Value | n/a | private | **must** set `maxmemoryPolicy: noeviction` (BullMQ needs it) and check persistence on the plan |
| Object storage | Cloudflare R2 (outside Render) | n/a | n/a | private bucket, CORS for the frontend origin only |

### 3.2 Code and config changes
- **`env.ts` production profile:** when `NODE_ENV=production`, require `COOKIE_SECURE=true`, `TRUST_PROXY=true` (Render sits behind one proxy, so set the trusted hop count explicitly), an HTTPS `CORS_ORIGIN`, an HTTPS `S3_PUBLIC_ENDPOINT`, and no `minioadmin` credentials. Refuse to boot otherwise. Add tests.
- **R2 compatibility:** `S3_REGION=auto`, endpoint `https://<account>.r2.cloudflarestorage.com`. Check whether the signer's hard-coded `forcePathStyle: true` works with R2 presigned PUT/GET and make it env-driven if needed. Integration test against MinIO stays as is; a manual R2 check is recorded as evidence.
- **R2 CORS:** `deploy/r2-cors.json` (exact frontend origin, `PUT`/`GET`, the `Content-Type` header, max-age), applied with `wrangler` or the dashboard; steps go in `docs/DEPLOYMENT.md`.
- **Legacy MinIO env cleanup:** the `MINIO_*` variables duplicate the `S3_*` ones. Confirm nothing still reads them, then drop them from the production blueprint (keep compose compatibility).
- **Health checks:** Render `healthCheckPath: /health` for backend and frontend. The worker has no HTTP port, so add a heartbeat key in Redis (`worker:heartbeat`, 30 s TTL) that backend `/health` reports.
- **Model cold start:** ML images already pre-download models at build time. Record the measured boot-to-ready time.
- **Secrets:** every secret is `sync: false` in `render.yaml` (set in the dashboard, never committed): `JWT_SECRET`, `INTERNAL_API_TOKEN`, `S3_ACCESS_KEY`/`S3_SECRET_KEY`, `OPENROUTER_API_KEY`, `FIRECRAWL_API_KEY`, OTLP headers. Gitleaks re-scan after.
- **LLM in production:** follow RULE S2 (OpenRouter only). The production blueprint sets only `OPENROUTER_*`; the Gemini and Groq keys are left out.

### 3.3 Production verification (evidence required)
1. Blueprint applies cleanly; all services healthy.
2. Migrations ran at pre-deploy; `prisma migrate status` is clean.
3. `ml` is unreachable from the public internet (curl from outside fails).
4. Real browser test on the deployed URL: register, upload (presigned PUT to R2 works with CORS), PARSED, match, analysis, usage meters, delete account (R2 objects are removed).
5. Security headers and cookie flags (`Secure`, `HttpOnly`, `SameSite`) checked on the live domain; OWASP ZAP baseline re-run against production.
6. `e2e/smoke.mjs` pointed at production passes.
7. Low-rate k6 smoke against production (1 VU, a few iterations). The mock LLM doesn't exist in production, so analysis is either skipped or run on the free OpenRouter tier within the S2 budget.

### 3.4 Deliverables
- [ ] `render.yaml`, `deploy/r2-cors.json`, `docs/DEPLOYMENT.md` (first deploy, secret list, rollback, migration failure handling, cost notes with the date pricing was checked)
- [ ] Production env guard + tests
- [ ] Worker heartbeat + health reporting
- [ ] Production verification evidence (§3.3)

---

## 4. Workstream D: Developer experience, README, and demo

### 4.1 One-command local setup
- `scripts/bootstrap.ps1` and `scripts/bootstrap.sh`: copy `.env.example` to `.env` if missing, generate `JWT_SECRET` and `INTERNAL_API_TOKEN` with a CSPRNG, and leave provider keys empty (LLM-off by default).
- Then `docker compose up --build` is the single command. Profiles: `--profile observability`, `--profile loadtest`.
- `make health` / `scripts/health.ps1`: print each container's health state (SPEC §7.2 asks for this).
- Make targets: `loadtest-smoke`, `loadtest-full`, `memory-matrix`, `obs-up`.

### 4.2 README rewrite
Sections: what it is (one paragraph), live demo link, architecture diagram (Mermaid: frontend, backend, Redis/BullMQ, ml-worker/ml-api, Postgres+pgvector, R2, LLM gateway, OTel), the request lifecycle, engineering highlights with **links to evidence** (retrieval eval metrics, parsing accuracy, k6 results, idempotency/DLQ, security audit), quick start (3 commands), running tests, observability, deployment pointer, limitations. Every number in the README links to a committed results file. Nothing is claimed without one.

### 4.3 Demo
- Deployed URL in the README. Seed a `demo` account? (decision D4)
- Short screen recording or GIF of the main flow, plus one trace screenshot and one dashboard screenshot.

### 4.4 Resume bullets (ROADMAP: "only after measurement")
Draft bullets in `docs/RESULTS_SUMMARY.md` using only measured numbers from `docs/PERFORMANCE.md`, `docs/eval/*`, and `docs/SECURITY.md`.

---

## 5. Execution order

| Step | Work | Why this order |
|---|---|---|
| 10B-0 | Pre-flight: git clean, full test suite green, stack boots | Baseline for detecting regressions |
| 10B-1 | Workstream A: harness, guards, mock LLM, baseline runs, memory matrix | Numbers *without* telemetry are the baseline; memory decides Render sizing |
| 10B-2 | Workstream B: OTel, logs, dashboards, PII tests, overhead re-run | Tracing then explains the bottlenecks k6 found |
| 10B-3 | Bottleneck fixes (only ones the traces prove), then re-run k6 | Measured improvement, not guesses. Each fix is listed with before and after numbers |
| 10B-4 | Workstream C: render.yaml, prod guards, R2, deploy, verify | Needs sizing from 10B-1 and telemetry from 10B-2 |
| 10B-5 | Workstream D: bootstrap, README, demo, bullets | README links to evidence that now exists |
| 10B-6 | Closure: ROADMAP/SPEC update, evidence index, verdict | RULE.md definition of done |

Each step ends with its tests passing, a diff review, and a stop for your commit approval (RULE: no commits without authorization).

---

## 6. Decisions needed from you

| ID | Decision | Default if you don't choose |
|---|---|---|
| D1 | Render budget and instance sizes. ML API + worker need at least 1 GB each (2 GB preferred), which rules out the 512 MB tier and makes the plan paid. | Pick sizes after the §1.5 memory matrix, then present the cost before deploying |
| D2 | Production telemetry backend (Grafana Cloud free tier, Honeycomb, or none in production) | Grafana Cloud free tier over OTLP |
| D3 | Custom domain or `*.onrender.com` | `onrender.com` |
| D4 | Public demo: open registration, a read-only seeded demo account, or invite-only | Open registration with the existing usage limits (demo plan) |
| D5 | LLM in the live demo: OpenRouter free tier on, or LLM-off (ML scores only) | OpenRouter free tier, per RULE S2 |
| D6 | Whether the `RATE_LIMIT_MULTIPLIER` approach (§1.3) is acceptable | Yes, with the production boot guard |

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Local laptop numbers don't reflect Render | Document the environment; run a low-rate production smoke; never present laptop numbers as production capacity |
| Load test accidentally calls real LLM or Firecrawl providers | Mock LLM + `MockJobSource` forced in the loadtest profile; provider-hostname log ledger checked before and after every run |
| PII leaks into traces | Attribute allowlist + canary tests as a CI gate |
| Render plan lacks pre-deploy, pgvector, or Key Value persistence | Check each against current Render docs before writing `render.yaml`; fallbacks are a one-off migrate job and AOF-enabled Key Value tier |
| OCR worker OOM in production | Size from the measured peak plus headroom; keep `MAX_OCR_IMAGE_DIMENSION`; DLQ catches failures |
| Cold starts on free or spun-down tiers break the demo | Document the behavior; choose non-sleeping tiers for backend and worker if the budget allows |

---

## 8. Definition of done (Phase 10B)
- k6 results for ingestion, match, analysis, mixed, and soak committed, with SPEC §6 target vs actual stated honestly
- ML memory matrix committed; Render sizing justified by it
- End-to-end traces across Node, BullMQ, and Python, plus LLM token/cost metrics, PII canary tests passing
- `render.yaml` deployed; production verification §3.3 done with evidence
- One-command local setup; README rewritten with links to evidence; demo live
- All existing suites still green (backend vitest, ml pytest, frontend vitest, eval gate, e2e smoke)
- ROADMAP and SPECIFICATION updated; final verdict: `VERIFIED` / `PARTIALLY VERIFIED` / `BLOCKED`
