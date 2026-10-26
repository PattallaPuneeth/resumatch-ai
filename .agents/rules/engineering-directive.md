---
trigger: always_on
---

# ResuMatch AI — Permanent Engineering Directive

Treat this as a permanent directive for the entire `PattallaPuneeth/resumatch-ai` project.

My goal is to build **a production-minded AI resume platform that showcases strong backend and distributed-systems engineering**, not merely an LLM wrapper.

## Core principles

1. **Follow the specification:** Read and obey `docs/SPECIFICATION.md` as the single source of truth. Preserve completed phases, existing contracts, architecture, and working code. Never silently change them.

2. **Build real engineering value:** Prioritize correctness, security, reliability, maintainability, and measurable performance over adding features for appearance.

3. **Make AI measurable:** When matching and retrieval are implemented, evaluate BM25, vector search, hybrid retrieval, and reranking using a labeled dataset and metrics such as Recall@K, Precision@K, MRR, and NDCG. Never fabricate results or claim an arbitrary score is objectively accurate.

4. **Prove distributed-systems skills:** Test queue retries, duplicate jobs, idempotency, worker crashes, recovery, concurrency, and database consistency. Measure actual throughput and latency instead of merely claiming scalability.

5. **Enforce security:** Verify authentication, authorization, tenant isolation, private file storage, signed URL behavior, input validation, and protection of sensitive resume data.

6. **Demonstrate reliability:** Test real document processing, failure scenarios, status transitions, persistence, and end-to-end workflows. Keep logs and errors safe and useful.

7. **Avoid unnecessary complexity:** Do not introduce Kafka, Kubernetes, extra databases, microservices, or other technologies unless a demonstrated requirement justifies them. Explain trade-offs before proposing architectural changes.

## Execution rules

- Inspect the actual repository and Git status before every phase.
- Resume from the real verified state. Phase 1, Phase 2A, Phase 2B, and Phase 2C have been reported complete; verify their state rather than blindly repeating them.
- Identify the next phase from `docs/SPECIFICATION.md` and proceed sequentially.
- Implement only the current phase, run relevant tests, inspect the diff, and preserve unrelated user changes.
- Never claim completion without evidence. Distinguish passed, failed, skipped, and untested checks.
- Do not commit without my authorization.

## Definition of done

A phase is complete only when its acceptance criteria are implemented, relevant automated tests pass, integration behavior is verified where applicable, regressions are checked, and remaining limitations are documented.

At the end of each phase, report the changes, tests and actual results, security/reliability checks, Git status, unresolved issues, and one verdict: `VERIFIED`, `PARTIALLY VERIFIED`, or `BLOCKED`.

**Product direction:** ResuMatch AI must demonstrate that I can engineer a secure, reliable, measurable backend system whose AI capabilities are part of the solution—not the entire solution.
## Standard close-out (every phase)
- Prove each change with raw command output (grep/Select-String, test names, counts). Never claim a file contains something without showing it.
- List every file touched outside the phase's scope as deviations. "None" only if git diff --stat confirms it.
- Run one real end-to-end check through the actual HTTP path (backend to ML), not only mocked tests.
- Security items (IDOR, secrets/defaults, PII in logs/prompts, input caps): PASS/FAIL with evidence.
- Rebuild images (no docker cp). Full test suites, tsc, prisma validate. Ruff/mypy on changed files only.
- Report exact test counts and the number of live LLM provider attempts, including failed ones.

## STANDING EXTERNAL-CALL BUDGET

- **S2. LLM PROVIDER = OPENROUTER ONLY:** Maximum 4 LLM provider HTTP requests in total for this entire task (retries and failover count). Gemini, Groq and every other direct provider must be disabled for any live action. If OpenRouter fails, do NOT fall back to another provider; stop and report.
- **S3. FIRECRAWL HARD CAP = 20 CREDITS:** For this task, counted from now. You cannot see credits, so assume the WORST CASE observed: 11 credits per /search request. Therefore at most ONE live Firecrawl /search request is allowed (a second could reach 22). A live run is allowed only if ALL are true: fan-out forced to exactly 1 query, result limit 3, page scraping/formats disabled (search only), and a code-level guard exists that rejects anything beyond that. If you cannot prove all four with a mocked test first, do ZERO live Firecrawl calls. After the one live request, STOP and tell me to check my Firecrawl dashboard; do not run another.
- **S4. Count real provider requests, not API calls:** One of our API calls can fan out into several provider requests. Your ledger must be built from `docker compose logs --since <start> | Select-String -NotMatch '/health'` (backend + ml + ml-worker), listing every outbound provider request with timestamp. If you cannot see a provider request in logs, add non-secret logging (provider, endpoint, query count, limit; never keys or payload text) so you can.
