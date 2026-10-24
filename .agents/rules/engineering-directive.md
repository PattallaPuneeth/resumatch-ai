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
