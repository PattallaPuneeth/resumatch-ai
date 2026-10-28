# Load testing (Phase 10B)

k6 scenarios that exercise the real stack (Fastify, BullMQ, Python worker, Postgres/pgvector, MinIO)
through the same API the browser uses. Results are evidence: only numbers produced by these
committed scripts against a clean stack go into `docs/PERFORMANCE.md`.

## Safety rails

| Rail | How |
|---|---|
| No real LLM calls (RULE S2) | `docker-compose.loadtest.yml` points every LLM tier at `mock-llm` via `LLM_BASE_URL_OVERRIDE` and blanks the Gemini/Groq keys. The override only accepts `mock-llm`, `localhost` or `127.0.0.1` (`ml/pipelines/llm/config.py`). |
| No Firecrawl calls (RULE S3) | `FIRECRAWL_API_KEY` blanked, so the backend uses `MockJobSource`. |
| Provider ledger (RULE S4) | `run.sh` greps backend/ml/ml-worker logs for provider hostnames after every run and writes `*.provider_ledger.txt` (must be empty). |
| Rate limits | Per-route limits are scaled by `RATE_LIMIT_MULTIPLIER` (default 100 in the overlay). The backend refuses to boot in production with a multiplier other than 1 unless `LOADTEST_ALLOW=true`. Auth limits are never scaled. |
| No residue | Each run registers throwaway `lt_<run>_<n>` users in `setup()` and deletes them (cascading resumes, jobs, objects) in `teardown()`. |

## Run

```bash
docker compose -f docker-compose.yml -f docker-compose.loadtest.yml up -d --build
```

```bash
loadtest/run.sh smoke
```

```bash
loadtest/run.sh ingestion baseline -e PEAK_RATE=2
```

`run.sh <scenario> [label] [k6 args]` writes `results/<stamp>_<scenario>_<label>.{txt,json,meta.txt,provider_ledger.txt}`.

Run `smoke` once before measuring: the first jobs after a worker restart load the ML models (about 30 s each), which is a cold-start cost, not steady state.

## Scenarios

| Scenario | What one iteration does | Load shape | Knobs |
|---|---|---|---|
| `smoke` | Full flow once: upload, parse, job, match, analysis, Idempotency-Key replay (asserts the meter grows once), browse | 1 VU, 1 iteration | none |
| `ingestion` | Presign, PUT to S3, complete, poll until PARSED. Mix: 50% text PDF, 25% DOCX, 20% 1-page scan, 5% 5-page scan | ramping arrival rate to `PEAK_RATE` uploads/s | `PEAK_RATE` (2) |
| `match` | New JD, trigger match, poll until `finalScore` | stepped arrival rate | `MATCH_STEPS` (`1,2,4`), `STEP_DURATION` (2m) |
| `analysis` | New JD, match, structured analysis against the mock LLM (unique JD, so the LLM cache always misses) | constant arrival rate | `ANALYSIS_RATE` (1), `DURATION` (3m) |
| `mixed` | 10% upload, 50% browse, 30% match, 10% analysis | ramp to `RATE` iterations/s | `RATE` (6), `SOAK=1` + `SOAK_DURATION` (30m) for a soak |
| `single_upload` | One upload of `FIXTURE` (`text`, `docx`, `scan1`, `scan5`, `heavy`) | 1 iteration | used by `memory/measure.sh` |

Common knobs: `USERS` (20), `POLL_INTERVAL_S` (0.5), `POLL_TIMEOUT_S` (90), and `JD_FILE` for real
job descriptions (a JSON list of `{title, description}`, e.g. `/loadtest/local/real_jds.json`). Keep
such files under `loadtest/local/`, which is gitignored, because scraped postings are usually
unlicensed. Without `JD_FILE`, jobs use a short synthetic JD. Real JDs are much longer and cost about
8x more per match (see `docs/PERFORMANCE.md`, Finding 4).

## Metrics

- `ingestion_e2e{type:text|ocr}`: upload start until the API reports PARSED (client-side; poll interval adds up to 0.5 s).
- `match_e2e`: match trigger until a score is readable.
- `analysis_e2e`: analysis trigger until the analysis row is readable.
- `pipeline_timeouts{stage}` / `pipeline_failures{stage}`: polls that hit `POLL_TIMEOUT_S` / resumes that ended FAILED.
- Standard `http_req_duration` tagged by `name` (e.g. `upload_url`, `resume_list`, `match_trigger`).

## Memory matrix

```bash
loadtest/memory/measure.sh 2g
```

Restarts `ml-worker` with the given memory limit, then processes each fixture alone while sampling `docker stats`.

## Fixtures

`fixtures/` holds synthetic resumes only (copies of `test-data/resumes` plus image-only scans built from them). Regenerate with `fixtures/generate_fixtures.py` (instructions in its docstring).
