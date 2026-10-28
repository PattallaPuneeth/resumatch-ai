# ML + Phase 10B work: progress log

Resume point for "continue". Times are IST. Read this file first, then pick the first unchecked item.

## Scope (from the user, 2026-10-28 ~00:50 IST)
- Find **all** ML matching bugs first, then fix them (tests for each), re-run eval, push to `main`.
- Finish the rest of Phase 10B **except deployment (Workstream C dropped for now)**.
- Ownership agreed with the other session ("Next project phase", local_f76b0976...): it owns Workstream A
  (loadtest/*, docker-compose.loadtest.yml, k6-smoke CI job, docs/PERFORMANCE.md). This session owns
  ml/pipelines/matching|embeddings, ml/eval, test-data, ml/worker.py (handed over at 66009f7), plus
  Workstreams B (OpenTelemetry) and D (README / one-command setup). **Tell the other session before
  editing docker-compose.yml.**
- Don't run heavy jobs while a k6 run is active (check `docker ps | grep k6`). Heavy eval runs go in a
  one-off `docker run --rm project-cbp-ml:latest` with the repo mounted.
- Stage files by path only (never `git add -A`), `git pull --rebase` before push.
- No LLM or Firecrawl calls. Scores come from ML only.

## Done (pushed to main)
- [x] `5763092` fix(ml): long-JD embedding crash, free +25 coverage, resume-text skills, 143-skill taxonomy,
      reranker fallback query, parser "go"/"R&D" false positives, eval harness = production path,
      ruff 128 to 0 and mypy 24 to 0, `ml/tests/test_ml_failure_regressions.py`
- [x] `160120d` fix(ci): prisma validate DATABASE_URL, trivy-action v0.36.0, e2e secrets
- [x] `b607a1e` feat(eval): datasets versioned in `ml/eval/datasets/` (handwritten + kaggle_domain with
      tune/test split), MRR/P@K/R@K/NDCG@K, `--split`
- [x] `580d539` ci(ml): integration tests (DB/S3) run inside the e2e compose stack

## State after "continue" (~04:05 IST)
All Phase 10B work in this session's scope is pushed:
- d8299d6 backend request spans + BullMQ traceparent propagation, vitest canary test
- d6027ad otel-lgtm `observability` profile, 2 dashboards (all queries checked against a live
  otel-lgtm), cross-service trace evidence, SEC-14
- e721b0e README rewrite with linked evidence
- ef7227c backend CI REDIS_URL fix (vitest hang reproduced and fixed locally on the CI stack)

Open (documented in observability/README.md and ML_FAILURE_ANALYSIS.md §6):
- LLM token/cost and usage-meter metrics and dashboards (not emitted yet)
- Tracing overhead k6 rerun (other session's area)
- Required vs preferred skills at job creation (top ML improvement)
- Human-labeled eval set

## Round 2: 4-sprint plan (2026-10-28, from ~07:20 IST)
User rule: keep a change only if it measurably helps. **The user asked for no commits or pushes**,
so all of this is uncommitted in the working tree.
- [x] 1A rerank cap 20 → 8: **rejected**. Real resumes have a median of 3 chunks (1 of 908 has > 8). The eval
      runner now reads `TOP_K_CANDIDATES` like the worker.
- [x] 1B required/preferred (weight 0.5) + "or" groups + finance aliases: **kept**. Kaggle test band
      0.758 → 0.802, handwritten 0.938 held. JD form gets skill chips; backend caps skill arrays (50 × 80).
- [x] 2B int8 cross-encoder: **rejected**. 2× faster, but Kaggle band −2.4 pts and extended pairwise −0.6.
- [x] 3A LLM token/cost metrics + `observability/dashboards/llm-usage.json`: all 7 queries checked on a
      live otel-lgtm, exemplars present, PII canary test added.
- [x] 3B Match Inspector: top passages with highlighted skills, preferred-skill pills.
- [x] 2A OCR worker: **opt-in only** (`--profile ocr-worker`, `OCR_QUEUE_ENABLED=true`). Ingestion text p95
      60.6 s → 0.8 s, but mixed-load match p95 doubled (CPU contention on 4 vCPU). Analysis §8.4.
- [x] UI redesign. A first dark "AI-tech" version was rejected by the user as looking AI-made, and
      was replaced with a light design:
      - white with warm off-white sections, green-700 primary, soft orange highlights;
      - Fraunces display headings over Inter body text;
      - quiet Framer Motion 11.18.2 reveals, a timeline line that draws in, and the gauge arc
        sweeping in (numerals stay exact, Rule S7).
      Landing claims were corrected (the reranker is ms-marco-MiniLM; no virus-scan claim).
- [x] Seniority signal: shown in match explanations, not scored. A penalty would change 1 of 761
      eval pairs (analysis section 8.5).
- [x] 4A `ml/eval/mine_hard_pairs.py` + `ml/eval/labeling/hard_pairs_to_label.csv` (50 pairs for the
      user to label), regenerated on the final scoring.

## In progress / next (older list)
- [ ] Final official eval (`python -m ml.eval.run`) on ci / handwritten / extended / kaggle test+tune.
      Outputs in the scratchpad `final/`. Then write `docs/eval/ML_FAILURE_ANALYSIS.md` with before/after.
- [ ] Check CI for 580d539 (ML CI pytest, e2e integration step). Use the public API:
      `curl -s https://api.github.com/repos/PattallaPuneeth/resumatch-ai/actions/runs?branch=main`
- [ ] Model trials: RERANKER_MODEL_NAME=cross-encoder/ms-marco-MiniLM-L-12-v2, EMBEDDING_MODEL_NAME=
      BAAI/bge-small-en-v1.5 (needs HF_HUB_OFFLINE=0 and a writable HF_HOME), plus a memory check
- [ ] Workstream B: OpenTelemetry (Node + Python, traceparent through BullMQ, PII allowlist + canary
      tests, grafana/otel-lgtm under compose profile `observability`, 4 dashboards, overhead re-run)
- [ ] Workstream D: scripts/bootstrap.{sh,ps1}, health script, README rewrite with evidence links

## Findings not fixed here (documented)
- Calibration: fitting weights/sigmoid on the tune split helped kaggle test band accuracy (0.770 to 0.873)
  but hurt handwritten (0.844 to 0.781). Production weights and the 75/45 bands are kept.
- Kaggle labels are auto-generated by keyword counting; R0118 (working accountant) is labeled weak for
  the Accountant job.
