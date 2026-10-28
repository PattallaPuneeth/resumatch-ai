# Performance and Capacity (Phase 10B)

All numbers here come from the committed k6 harness (`loadtest/`) against the Docker Compose stack
with the load-test overlay (mock LLM, MockJobSource). Raw outputs live in `loadtest/results/`.
These are **laptop numbers**: they describe this environment, not production capacity.

## Test environment

| Item | Value |
|---|---|
| Host | Windows 11, 16 logical CPUs, 16 GB RAM |
| Docker | Docker Desktop, engine 29.6.1; VM limited to 4 CPUs and 5.8 GB RAM |
| Stack | `docker-compose.yml` + `docker-compose.loadtest.yml` (all services on one VM) |
| ml-worker | 1 process, 4 BullMQ workers (parse, embed, match, analysis), concurrency 2 each, 2 GB limit |
| LLM | `mock-llm`, 800 ms ±20% latency, schema-valid grounded JSON |
| k6 | `grafana/k6:1.0.0`, inside the compose network |
| Commit | `24d4664` plus uncommitted Phase 10B harness changes (each results `*.meta.txt` records the state) |

## Baseline results (before any fix)

Run on 2026-10-27 (IST evening), worker warmed by a smoke run first. Each row links to the raw k6 output.
"Timeout" means the poll gave up after 90 s (`POLL_TIMEOUT_S`); those iterations are not in the latency figures, so the real tail is worse than the p95 shown.

| Scenario | Load | Key result | SPEC target | Verdict |
|---|---|---|---|---|
| [match](../loadtest/results/20261027T180240Z_match_baseline.txt) | 1, 2, 4 new-JD matches/s, 2 min each | `match_e2e` p50 26.8 s, p95 81 s; **151 of 533 (28%) timed out**; 309 iterations dropped (no free VU) | none set (harness gate p95 < 10 s) | FAIL |
| [analysis](../loadtest/results/20261027T181102Z_analysis_baseline.txt) | 1 analysis/s for 3 min (mock LLM, 0.8 s) | `analysis_e2e` p50 35.7 s, p95 52.3 s; all 170 completed with `llmStatus` stored. **Caveat:** the JD marker was digits, which PII redaction replaced with `[PHONE_NUMBER]`, so almost every analysis was an LLM cache hit. This row measures queue time plus cache lookup, not an LLM call (harness fixed afterwards) | none set (harness gate p95 < 15 s) | FAIL |
| [mixed](../loadtest/results/20261027T181432Z_mixed_baseline.txt) | ramp to 6 iterations/s (10% upload, 50% browse, 30% match, 10% analysis) | **uploads: 129 of 238 (54%) not PARSED within 90 s**; match: 61 of 157 (39%) timed out; `ingestion_e2e` p95 63 s; `match_e2e` p95 78 s | text p95 < 3.5 s | FAIL |
| [ingestion](../loadtest/results/20261027T182114Z_ingestion_baseline.txt) | ramp 0.5, 1, 2 uploads/s (50% text PDF, 25% DOCX, 25% scans) | text p95 79 s, OCR p95 69 s; **92 of 141 (65%) not PARSED within 90 s**; 64 iterations dropped. Uncontended minimum: text 548 ms, OCR 5.6 s | text p95 < 3.5 s, OCR p95 < 8 s | FAIL under load; single requests meet both targets |

What held up:
- **API layer:** 0 failed HTTP requests out of 180,791 across the four runs. Read endpoints stayed fast under the heaviest load: `GET /v1/resumes` p95 28 ms and `GET /v1/usage` p95 33 ms in the mixed run.
- **Correctness under load:** no resume ended FAILED (`pipeline_failures` = 0), every analysis that ran was stored, and the provider ledger was empty for every run (0 real LLM or Firecrawl requests).

What didn't: everything that goes through the `ml-worker` queues. During the ingestion re-run the parse
queue backlog grew steadily (2 to 76 waiting jobs in about 2 minutes) while `ml-worker` used 1.3 to 2.7 of
the VM's 4 CPUs, so on this machine parse/OCR throughput is below about 1 to 2 uploads/s with a 25% OCR mix. The
pickup stalls from Finding 1 add tens of seconds on top, which is why even the 1 match/s step missed.

Note on request volume: about 155 req/s in these runs is mostly status polling (every 0.5 s per waiting
iteration), which is heavier than the real frontend polls. It barely loaded the backend (under 45% of
one CPU), so it doesn't explain the latency.

## Finding 1: event-loop blocking in `ml-worker` stalls BullMQ pickup

**Symptom (smoke runs, 2026-10-27).** On a freshly started worker, the match job never ran: it sat in
`bull:match-scoring-queue:wait` for minutes until another job arrived or the worker restarted. With a
warm worker the flow passed, but a single match took 41 to 50 s, and an analysis waited about 20 s in
the queue while the worker was idle.

**Root cause.** `ml/worker.py` runs four BullMQ `Worker`s in one asyncio event loop. Job handlers do
CPU-bound work synchronously on that loop, and the two transformer models load lazily on first use:

| Event | Measured duration (blocking) |
|---|---|
| `SentenceTransformer` load on first embed job | 31.5 to 32.3 s |
| `CrossEncoder` load on first match job | 30.7 s |

While the loop is blocked, every other worker's blocking Redis wait and lock renewal stops too.

**Isolation proof.** Probe scripts (Node `bullmq@5.81.5` producer, Python `bullmq==3.4.3` worker, same
options as `ml-worker`) on a throwaway queue:

| Probe | Pickup lag |
|---|---|
| 1 worker, idle, concurrency 1 or 2 | 3 to 29 ms |
| 4 workers in one loop, idle | 3 to 13 ms |
| Job added during a 31 s `time.sleep` in another worker's handler | 40 s (picked up 12 s after the loop was free) |
| Jobs added after the block | 5 ms to 6 s, arriving in batches |

So the library is fast when the loop is free; the delays come from blocking work in our handlers.
Side effect: BullMQ's stalled-job checker re-ran the embed job that held the loop through model load
(duplicate `embed-<resumeId>` processing). That is harmless because embedding is idempotent, but it
is wasted work.

**Fix (Phase 10B-3, commit `dc2f3f1`).** (1) `warm_models()` loads both models at worker startup,
before the BullMQ workers start. (2) S3 I/O, parse/OCR, embedding, retrieval, reranking and their DB
writes run in `asyncio.to_thread`. Regression test `ml/tests/test_worker_event_loop.py`: the loop
must keep ticking while a handler does blocking inference (0 ticks on the old worker).

## Finding 2: concurrent OCR in threads hangs (regression from the Finding 1 fix)

Moving parsing into threads let both parse slots run PyMuPDF/Tesseract at the same time. In the
[first after-fix ingestion run](../loadtest/results/20261027T185605Z_ingestion_afterfix.txt) two OCR
jobs started together and took **4 min 51 s and 12 min 43 s** (a lone OCR job takes ~7 s); the parse
queue processed nothing else meanwhile, so only 11 of 139 uploads reached PARSED. PyMuPDF doesn't
support concurrent use from several threads, and Tesseract's OpenMP threads competed with PyTorch's
on 4 vCPUs.

**Fix.** `ml/worker.py` serializes `parse_document` behind a thread lock (still off the event loop).
Regression test: three concurrent parse jobs never run `parse_document` at the same time, and the
loop keeps ticking.

## Finding 3: baked models hidden by a tmpfs, re-downloaded on every start

`docker-compose.yml` mounts a tmpfs at `/home/appuser/.cache` for `ml` and `ml-worker`, which is
where the image baked the Hugging Face models. Each container start therefore re-downloaded
88 MB of weights from the internet into RAM. (Found by the parallel ML analysis session.)

**Fix.** `ml/Dockerfile` bakes the models into `/opt/hf` (`HF_HOME`) and sets `HF_HUB_OFFLINE=1`.

| Worker startup | Before | After |
|---|---|---|
| Model preload | 61.3 s (mostly downloading) | **0.2 s** (from disk) |
| Model bytes in tmpfs (RAM) | 88 MB | 0 |
| Idle worker memory, models loaded | ~830 MiB | 461 MiB |
| Works offline | no | yes |
| ML test suite time | ~85 s | ~21 s |

## After the fixes

| Scenario | Baseline | After all fixes | Notes |
|---|---|---|---|
| smoke, **cold** worker | match never ran (stuck in queue) | [17/17 checks](../loadtest/results/20261027T193341Z_smoke_cachefix.txt); match 0.53 s, analysis 1.55 s (real mock-LLM call) | the original bug |
| [analysis](../loadtest/results/20261027T190959Z_analysis_afterfix.txt), 1/s for 3 min | p95 52.3 s (and mostly LLM cache hits) | p95 **14.3 s**, median 1.05 s, 181/181 stored, every one a real mock-LLM call; all thresholds pass | |
| [ingestion](../loadtest/results/20261027T192541Z_ingestion_afterfix2.txt), ramp to 2/s | 49 of 141 PARSED (35%); text p95 79 s, OCR p95 69 s | **70 of 144 PARSED (49%)**; text p95 77 s, OCR p95 67 s | now a throughput ceiling, see below |
| [match](../loadtest/results/20261027T200246Z_match_afterfix2.txt), 1/2/4 per s | 382 of 533 scored (72%); median 26.8 s, p95 81 s | 338 of 576 scored (58%); **median 2.1 s**, p95 74 s | median fixed (stalls gone), but completion within 90 s is lower; see throughput note |
| [mixed](../loadtest/results/20261027T201108Z_mixed_afterfix2.txt), ramp to 6/s | uploads 46% PARSED; match 61% scored, p95 78 s | uploads 29% PARSED; **match 99% scored**, p95 55 s; analysis p95 12 s | uploads now queue behind serialized OCR; reads fast (resume list p95 45 ms) |

(An earlier after-fix [match](../loadtest/results/20261027T190136Z_match_afterfix.txt) and
[mixed](../loadtest/results/20261027T191332Z_mixed_afterfix.txt) run overlapped the Finding 2 OCR hang
and is kept only as a record.)

**Throughput didn't improve.** Worker logs for the after-fix match run show 396 matches completed in
the 8.3-minute window (about 0.8/s), and 105 in the 2.5-minute 4/s step (about 0.7/s). The baseline
scored at least 382 matches in the same window, so its throughput was at least about 0.76/s. The
fixes removed the stalls (median latency, cold starts, stuck jobs), not the capacity limit.

**Thread-cap experiment: oversubscription isn't the limit (rejected).** Hypothesis: concurrent
inference threads each using PyTorch's thread pool were fighting over 4 vCPUs. The ML analysis session
tested it with `TORCH_NUM_THREADS` (commit `5ef5fb9`). Setup: same image, one sitting, smoke warm-up
first, nothing else on the stack, throughput counted from "Successfully persisted Match" lines in the
4/s step. PyTorch's default on this VM is 2 threads.

| | Default (2 threads) | 1 thread | 1 thread + OCR worker |
|---|---|---|---|
| Matches/s in the 4/s step | 0.69 | 0.71 | 0.73 |
| Matches persisted, whole run | 507 | 438 | 449 |
| Iterations / timeouts | 631 / 172 | 586 / 209 | 590 / 208 |
| `match` p50 / p95 | 6.6 s / 60.1 s | 9.2 s / 74.4 s | 10.3 s / 73.5 s |
| `mixed` match p50 / p95 | 26.1 s / 41.3 s | 31.8 s / 47.8 s | 11.3 s / 78.1 s |
| Idle smoke match | 0.5 s | 0.5 s | 0.5 s |

Raw files: `loadtest/results/20261028T06*_thr_*` (control run: `*_thr_default_clean`); write-up in
`docs/eval/ML_FAILURE_ANALYSIS.md` §8.7. Capping threads moved throughput by under 0.05 matches/s
and made latency worse, so `TORCH_NUM_THREADS` stays at PyTorch's default. **Matching is simply
CPU-bound at about 0.7 matches/s per worker on 4 vCPUs.** More throughput means more CPU or more
worker replicas, not tuning. That's a deployment sizing input.

0 failed HTTP requests and 0 real provider calls in every run.

**What's left is capacity, not stalls.** With the stalls gone, the worker processes match jobs back
to back at about 0.7 to 0.8 per second on this 4-vCPU VM, and parsing is serialized, so OCR (about 6 to 7 s
per scan) caps this upload mix at roughly 1 upload per second per worker process. Higher throughput
needs more worker processes or replicas (each with its own PyMuPDF), not code fixes. That's a sizing
input for deployment.

## ML memory (SPEC §7.4)

`loadtest/memory/measure.sh` restarts `ml-worker` with a memory limit, then processes one fixture at a
time while sampling `docker stats` every ~0.5 s. The text row includes the first-use load of the
embedding model. Raw files: [2 GB](../loadtest/results/20261027T182737Z_memory_2g.md),
[1 GB](../loadtest/results/20261027T183127Z_memory_1g.md).

| Fixture | Peak MiB (2 GB limit) | Peak MiB (1 GB limit) |
|---|---|---|
| idle, fresh process (no models loaded) | 319 | 349 |
| text PDF (+ embedding model load) | 603 | 527 |
| DOCX | 603 | 527 |
| 1-page scan (OCR) | 738 | 710 |
| 5-page scan (OCR) | 805 | 729 |
| 4.5 MB image-heavy PDF (worst case) | **850** | **772** |

No OOM kill at either limit. Other containers at rest after the runs: `ml` API 357 MiB, backend 152 MiB,
frontend 113 MiB, Postgres 93 MiB, Redis 20 MiB.

Limits of this measurement: one job at a time, so it doesn't show concurrent jobs (the worker runs up
to 2 per queue); the match path's cross-encoder model isn't loaded by these uploads (during the load
runs, with both models loaded, the worker sat at about 830 MiB); and 0.5 s sampling can miss short spikes.

Model-swap memory (measured by the ML analysis session: bare Python process, no load, peak RSS via
`ru_maxrss`): current pair `all-MiniLM-L6-v2` + `ms-marco-MiniLM-L-6-v2` 697 MB; with the L-12
reranker 740 MB; with `bge-small-en-v1.5` 741 MB. Neither swap was adopted: L-12 ranked worse on every
eval set and reranked 2× slower; bge-small was neutral on ranking and embedded 2.5× slower (details in
`docs/eval/`).

**Sizing (decision D1).** The spec's "512 MB is unsafe" holds: the worker passes 512 MiB on the first
text upload. 1 GB survives every single-job case but leaves only about 250 MiB of headroom on the worst
case before concurrency or the cross-encoder. **Recommendation: 2 GB for `ml-worker`, at least 1 GB for
the `ml` API.** Re-measure under concurrent load after the Finding 1 fix, before choosing Render plans.
