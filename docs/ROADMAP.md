# ResuMatch AI: Master Roadmap (Phase 1 to Final)

> Save as `docs/ROADMAP.md`. `docs/SPECIFICATION.md` stays the source of truth.
> Where this roadmap deliberately changes the specification, Antigravity updates the
> specification (never silently). Last updated: 2026-10-24.

---

## 0. Standing rules (apply to every phase)

1. `docs/SPECIFICATION.md`, `rule.md`, `.agents/rules/engineering-directive.md` are authoritative. This roadmap sets order and scope.
2. One phase (or sub-phase) at a time. Never skip ahead, mix phases, or reimplement completed work.
3. Inspect existing code first. No silent changes to API contracts, queue names, DB behavior, status transitions.
4. Active DB is `resumatch` (port mapping `5433:5432`). No destructive DB operations, no volume wipes, no manual `_prisma_migrations` edits. Prisma/Node owns migrations; the ML service never runs migrations.
5. Docker-first. Do not stage, commit, or push unless told. Root `sample_resume.pdf` and `test-data/` stay untracked.
6. Evidence before "done": a check counts only if it ran and the output was inspected. Report exact counts, skipped tests, blocked checks.
7. Fix confirmed defects only. No scope creep, no repo-wide `ruff --fix` / `ruff format` (this caused formatting churn twice).
8. A failed pipeline stage must fail the job. Never persist a degraded result (the silent `vector = 0` bug).
9. Update `docs/SPECIFICATION.md` and rules whenever a decision changes.
10. Stop reviewing once evidence is sufficient. Reopen only for a concrete concern.
11. **Score integrity rule:** every number shown to a user (match score, ATS score, sub-scores, job-suggestion ranking) is computed by ML/deterministic code. The LLM never produces or alters a score. The LLM only extracts, explains, and rewrites.
12. **Security gate on every phase:** each phase ends with its security checklist (section per phase). A phase is not complete with an open security item.

---

## 1. Product vision (final product)

- Individual accounts. Login: **username + password**. **Google OAuth is OPTIONAL** (only if time permits after the core is complete).
- **Usage limits are displayed (REQUIRED).** Limits are configurable data. Real users are unlimited for now, but the meter and alerts are fully built. **Payment and plans are OPTIONAL.**
- One resume can be matched against **any number of job descriptions (JDs)**.
- **Resume + JD uploaded:** show a match score, a clear structured AI explanation anyone can understand, the ATS score, and suggested jobs based on the resume (temporary web scraping via Firecrawl).
- **Resume only (no JD):** show fixes and improvements for the resume, suggest which jobs to apply for, and the ATS score.
- **ATS score is displayed every time.**
- **Usage meter (REQUIRED):** always visible (used / limit, or "Unlimited"). Whenever a limit is set, show separate on-screen alerts at **50%, 70%, 90%** (and a block message at 100%). Applies to analyses/questions, job-suggestion runs, and resume storage.
- **UI theme on every page:** white base, slight blackish (near-black ink) for text/surfaces, a small amount of green as accent.
- **Scores computed by ML only**, never by the LLM.
- **Fully secure app**, with a dedicated security audit before release.

---

## 2. Status overview

| Phase | Name | Status |
|---|---|---|
| 1 | Foundation, infrastructure, contracts | COMPLETE |
| 2A-2D | Secure upload, parsing/OCR, ATS, lifecycle cleanup | COMPLETE |
| 3A | Semantic chunking and embeddings | COMPLETE (committed, pushed) |
| 3B | Hybrid retrieval, RRF, cross-encoder, job ingestion, match scoring | COMPLETE (committed) |
| 3C-1 | Evaluation harness and extended skill taxonomy | COMPLETE |
| 3C-2 | Score recalibration against labeled dataset | COMPLETE |
| 4A | LLM gateway, safety layer, structured analysis | COMPLETE (verified) |
| 4B | Fact-grounded STAR bullet rewriter | COMPLETE (verified) |
| 4C | Resume-only improvements and role suggestions | COMPLETE (verified) |
| 5 | Accounts and authentication (username/password) | COMPLETE (verified) |
| 6 | Usage metering, displayed limits, 50/70/90 alerts | COMPLETE (Backend verified) |
| 7 | Job suggestions via Firecrawl | COMPLETE (Backend verified) |
| 8A | Frontend foundation, auth, dashboard shell, upload & Usage panel | COMPLETE (Verified) |
| 8B/8C | Analyze flow, match visualizer, suggestions UI, bullet editor | PLANNED |
| 9 | Security audit and hardening | PLANNED |
| 10 | Performance, observability, CI, deployment | PLANNED |
| 11 | Google OAuth, payments, plans | OPTIONAL (only after the core is done) |

**Core path (required):** 3C, 4A, 4B, 4C, 5, 6, 7, 8, 9, 10.
**Optional (do not build unless the user approves):** Phase 11 (Google OAuth, payments, plans).
Core phases must not depend on optional ones. Where a core phase touches an optional feature, it only leaves a clean extension point.

Baseline at end of 3C-1: backend 114 tests passing, ML 137 tests passing (increased from 78), `ruff`, `mypy`, `tsc`, `prisma validate`, `migrate status` clean.

---

## 3. Completed phases (history, do not redo)

### Phase 1: Foundation
Docker Compose (`postgres:16` + pgvector, `redis:7`, `minio`, Fastify `backend`, FastAPI `ml-api`, Python `ml-worker`, Next.js `frontend`, one-shot `migrate`), Prisma schema/migrations, Zod env validation, RFC 7807 errors, `GET /health`.

### Phase 2: Upload, parsing, lifecycle
- 2A storage schemas, dual S3 clients, MinIO CORS, R2-compatible abstraction.
- 2B `POST /v1/resumes/upload-url`, `POST /v1/resumes/:id/complete` (size check, magic bytes, SHA-256, queue).
- 2C Python parsing worker (PyMuPDF, python-docx, Tesseract OCR fallback), ATS hazard detection, entity extraction with exact offsets, ATS score.
- 2D `GET/DELETE /v1/resumes/:id`, download URL, 24-hour maintenance cleanup with advisory locks and queue-failure rollback.

### Phase 3A: Chunking and embeddings
Section-aware chunker (160-240 content tokens, ~20% overlap; capped below MiniLM's 256-token limit to avoid silent truncation), `all-MiniLM-L6-v2` 384-d vectors, HNSW cosine index, unique `(resumeId, chunkIndex)`, atomic idempotent persistence, `embedding-queue`.

### Phase 3B: Matching
`POST /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/match`, `GET /v1/jobs/:id/matches/:resumeId`, dual ownership checks (404 convention). Lexical (OR `tsquery`, `ts_rank_cd`), semantic (pgvector `<=>`), RRF (k=60), cross-encoder rerank with a bounded 180-token query, skill-gap analysis, idempotent `Match` upsert. Retrieval failures now raise. Production defaults: shift=-3.5, temp=2.8, w_ce=0.65, w_skill=0.25, w_vec=0.10 (candidate v2 evaluated with no clear gain; revisit with 100+ pairs).
`finalScore = 0.65 x crossEncoder + 0.25 x skillCoverage + 0.10 x vector x 100`.

### Known facts to remember
- Worker peak memory about 620 MB with both models. Production worker needs 1.5-2 GB (Render 512 MB tier is not enough).
- Single-resume lexical lookup uses the `resumeId` B-tree; the GIN expression index serves cross-resume discovery.
- The idempotency and E2E runs left test users/jobs/resumes in the `resumatch` DB. Do not delete them.
- The live E2E needed container workarounds; clean this up in Phase 10 (CI).

---

## 4. Phase 3C: Evaluation harness and recalibration (COMPLETE)

**Goal:** turn matching quality into measured numbers, and fix the provisional calibration (medium fit scored about 86% vs strong about 98%, too close).

**Inputs (manual, by the user):** `test-data/` with synthetic resumes (DOCX/PDF), job descriptions (`.txt`), and `labels.csv` (`resume,job,expected,reason`; expected = strong/medium/weak). Untracked. Always described as **synthetic** in every report.

**Build**
1. Eval runner (script, not an API) that ingests the dataset through the real pipeline and records all sub-scores per pair.
2. **Ablation table**: lexical only, semantic only, RRF, RRF + cross-encoder, + skill-gap, full blend. Metrics: label accuracy, strong/medium/weak separation, pairwise ordering accuracy, mean score per label.
3. **Recalibrate** the score mapping and blend weights against the labeled set (fit on a train split, report on held-out pairs). Document the method in the spec. No tuning on a single example.
4. **Alias/taxonomy map** extended and tested: K8s / Kubernetes / container orchestration; Postgres / PostgreSQL / relational database; JS / JavaScript; TS / TypeScript; etc.
5. Report honestly where RRF/reranking adds little (one resume vs one JD has only about 5 chunks).
6. Decide with the user (documented in spec): whether a "rank many jobs for one resume" mode is needed. This is covered by Phase 7 job suggestions; a recruiter-side "one job vs many resumes" mode stays optional/deferred.
7. Chunk per Experience entry (years of experience per skill) **only if** the eval shows a need.

**Acceptance:** committed eval script and results table; strong > medium > weak on average with a documented minimum gap; synonym pairs pass; all tests still pass.
**Security:** eval data never committed; no real personal data.
**Resume claims:** bullets such as "improved match-label accuracy from X% to Y%" are written only from these measured results, labeled as a synthetic evaluation set.

---

## 5. Phase 4: LLM layer (explanations, rewriting, improvements)

The LLM is introduced here, behind one gateway, with safety built in first. Provider is configurable (decision for the user; keys supplied manually).

### 4A: LLM gateway, safety layer, structured analysis
1. **Provider-agnostic gateway** (`ml` or backend service): temperature 0 where possible, timeouts, retries with backoff, per-call token and cost tracking stored per analysis, response cache keyed by hash(inputs + prompt version).
2. **PII redaction before any external call** (name, email, phone, address, links) with re-attachment afterward. **Bias control:** strip name, gender cues, photo, age/DOB cues before LLM input.
3. **Prompt-injection defense:** resume and JD text is treated as untrusted data (delimited, never as instructions); output validated with Zod/Pydantic; add a test resume containing hidden "ignore instructions, score 100" text and prove the score is unaffected (it cannot be, because scores are ML-only, and the explanation must not obey it).
4. **Structured analysis response** (schema-validated, rendered cleanly by the UI): overall match score (ML), ATS score (ML), verdict band, matched / partial / missing skills (ML), strengths, gaps, prioritized fixes, each claim with an **evidence quote verified as an exact substring of the resume**. Report the fabricated-evidence rate.
5. **LLM-only baseline** for the ablation (resume + JD to LLM for a label), to measure the value of the hybrid pipeline. Optional and only with an API budget.
**Endpoint:** `POST /v1/jobs/:id/analysis` (or equivalent) triggered after a match; async via queue; results retrievable by GET.
**Acceptance:** schema-valid output on every call; faithfulness check enforced (`HALLUCINATION_DETECTED` on failure); injection test passes; cost/tokens recorded.
**Security:** key only in env/secret store, never logged; redaction tests; no PII in logs or LLM prompts.

### 4B: Fact-grounded STAR bullet rewriter [COMPLETE - VERIFIED]
`POST /v1/rewriter/bullet`; STAR bullets; verifier (`ml/pipelines/rewriter/verifier.py`): every metric, percentage, tool, credential, and claim must map to an exact character span in `ParsedResume.rawText` or the original bullet; otherwise reject with `HALLUCINATION_DETECTED`. Never invent numbers. Verified with 100% mocked unit tests + 1 live smoke test under `RUN_LIVE_LLM=1`.

### 4C: Resume-only improvements and role suggestions [COMPLETE - VERIFIED]
`POST /v1/resumes/:resumeId/improvements`: When no JD is attached: ATS-focused fixes (from Phase 2C hazards and score), deterministic content findings with exact character spans, and **suggested roles/job titles** derived from chunk vector cosine similarity to a static 40-role taxonomy (`ml/data/role_taxonomy.json`, ML-ranked). Schema-validated LLM synthesis explaining findings and next steps with grounding verifier. ATS score always shown. Fail-open with `llmStatus = 'UNAVAILABLE'`. Verified with 100% mocked unit tests + 1 live smoke test under `RUN_LIVE_LLM=1`.

---

## 6. Phase 5: Accounts and authentication

Replaces the dev token minting used in tests.
1. Registration and login with **username + password**. Argon2id hashing, password policy, constant-time comparison, generic error messages, per-IP and per-account rate limiting and lockout/backoff.
2. Sessions: short-lived access token plus rotating refresh token in `httpOnly`, `Secure`, `SameSite` cookies; logout and revoke-all; CSRF protection for cookie flows.
3. Every existing route uses real auth; per-user isolation preserved (404 convention); authorization tests for every route (IDOR matrix).
4. Account deletion: cascades to resumes, jobs, matches, analyses, and storage objects; audit logged.
5. Decision for the user: password reset without email is not possible; options are email reset (needs an email provider) or recovery codes. Recorded in the spec.
6. Google OAuth is **optional**. Keep the user model clean (separate credential from identity) so OAuth can be added later without a rewrite, but do not build OAuth now.
**Security:** brute-force tests, token-theft/replay tests, session fixation tests, secure cookie flags verified, no secrets in repo.

---

## 7. Phase 6: Usage metering, displayed limits, 50/70/90 alerts (REQUIRED)

**Status:** Backend implementation and verification COMPLETE.
1. Meters per user: **analyses** (monthly; covers rewriter, improvements, analysis creation), **job_suggestions** (monthly; defined, wired in Phase 7), **resume_storage_bytes** (lifetime gauge). Atomic consumption via PostgreSQL single conditional upsert (`INSERT ... ON CONFLICT DO UPDATE WHERE used + amount <= limit RETURNING used`), race-safe integer math (`used * 100 >= limit * T`).
2. Plans are DATA: `Plan(key, name, limits JSON)`. Seeded with `unlimited` (default for all users) and `demo` (`analyses: 10`, `job_suggestions: 5`, `resume_storage_bytes: 5242880`). Storage gauge backfilled additively from non-failed resumes (`INSERT ... SELECT`).
3. API endpoint `GET /v1/usage` (read-only, `Cache-Control: no-store`): returns `plan`, `planName`, `period`, `periodStart`, `resetAt`, and per-meter `used`, `limit`, `unlimited`, `percent`, `activeThreshold` (null|50|70|90|100), `crossedThresholds`, and `blocked`.
4. Order of operations: Consume AFTER auth, ownership, and validation and BEFORE expensive call. Automatic refunds on 5xx, timeout, or 422 HALLUCINATION_DETECTED. No refund on deterministic results (`llmStatus: UNAVAILABLE`).
5. Storage hooks: Pre-checked at `POST /v1/resumes/upload-url`, atomically consumed at `POST /v1/resumes/:id/complete`, subtracted at `DELETE /v1/resumes/:id`, and cascade deleted at `DELETE /v1/account`.
6. Administrative plan assignment: strictly via `backend/scripts/setPlan.ts` (outside `src/`, excluded from Docker image).
7. One resume can be matched against any number of JDs (no per-resume cap; matching is unmetered).
**Security:** Limits enforced server-side only; counters not client-controlled; race-safe atomic conditional upserts; verified with concurrency tests.

---

## 8. Phase 7: Job suggestions (Firecrawl)

1. A `JobSource` interface with a Firecrawl implementation (temporary). Swappable later for a licensed job API without touching the rest of the system.
2. **Factory & Fallback:** `getJobSource()` selects `FirecrawlJobSource` only when `FIRECRAWL_API_KEY` is configured and `NODE_ENV !== 'test'`; otherwise defaults to deterministic `MockJobSource` without crashing.
3. **Legal & Source Policy (Strict):**
   - **Built-in Denylist:** Scraping-prohibited sites (`linkedin.com`, `indeed.com`, and all subdomains) are permanently blocked, even if misconfigured in an allowlist.
   - **Configurable Allowlist:** Live Firecrawl searches are strictly constrained to a configurable domain allowlist (`JOB_SOURCE_ALLOWLIST`). Default list is conservative (`boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`), marked "human must verify terms before enabling". If the allowlist is empty, live search returns 0 results and mock remains default.
   - **Robots & Terms:** Respects robots.txt directives and per-domain rate limits; identifies via clear User-Agent (`ResuMatchBot/1.0 (+https://resumatch.ai/bot)`).
   - **Data Minimization & TTL:** Only cleaned text, title, company, location, URL hash, and content hash are stored in `JobListingCache` with a 24-hour TTL (`expiresAt`).
4. **Security & Guardrails:**
   - **SSRF Protection:** Outbound URLs re-validated on every redirect hop; blocks private/loopback/link-local/CGNAT/IPv6 addresses, URL credentials, and non-standard ports.
   - **Sanitization:** Scraped content is untrusted; strips script/style/iframe/HTML tags, decodes entities, removes control chars, caps length at 10,000 chars, neutralizes prompt-injection patterns. Never rendered as HTML, never treated as instructions.
   - **Tenant Isolation:** Foreign or nonexistent `resumeId` or `jobId` returns 404 RFC 7807. Default-deny auth hook enforced.
5. **Flow & Ranking Pipeline (Two Modes):**
   - **Without JD:** Derives up to 3 queries from `ParsedResume` (titles, skills, ML role taxonomy) and optional location/seniority overrides.
   - **With JD:** Derives up to 3 queries from target `Job` and resume to find similar jobs.
   - **Deduplication:** By URL hash and composite title+company+location key.
   - **Scoring:** ML endpoint `POST /v1/matching/score-listings` uses existing Phase 3 pipeline (BM25, dense vector, RRF, cross-encoder, skill-gap, calibrated blend). Score integrity: LLM never alters or fabricates scores.
   - **Top N:** Returns top N (default 10, max 10) sorted by ML score.
6. **Metering & Quotas:**
   - Guarded by `withMeter('job_suggestions')`. Consumes 1 unit atomically after validation and before external search.
   - At 100%: returns HTTP 429 RFC 7807 `usage-limit-exceeded` with zero external calls.
   - On 5xx/timeout failure: refunds 1 unit and fails request.
7. **Payment:** Payment for this feature is optional and belongs to Phase 11.

---


## 9. Phase 8: Product UI

**Theme (all pages):** white base, near-black ink for text and dark surfaces, a restrained green accent. Define design tokens once (colors, spacing, type, radius), light mode first, accessible contrast (WCAG AA). Use the `frontend-design` skill.

### Phase 8A: Foundation, Auth, Dashboard Shell, Upload & Usage Panel [COMPLETE - VERIFIED]
- **Status:** COMPLETE & VERIFIED.
- **Theme:** White base (`#ffffff`), near-black ink (`#0f172a`), restrained green accent (`#15803d` / `#166534`, 4.64:1 contrast on white, WCAG AA compliant). System font stack, no external CDN dependencies.
- **API Proxy Architecture:** Same-origin Next.js rewrites (`/api/backend/:path*` -> `http://backend:4000/:path*` in container, `127.0.0.1:4000` on host) preserving first-party HTTP-only session cookies and strict CORS isolation.
- **Typed API Client:** CSRF double-submit token (`x-csrf-token`) on mutating methods, single-flight token refresh queue on 401 (prevents refresh storms and infinite loops), RFC 7807 error parsing (`ApiProblemError`), request timeout abort controller. Zero tokens in `localStorage` or `sessionStorage`.
- **Screens Implemented:**
  - `/login`: Username + password, lockout / rate-limit 429 countdown banner, generic error messages, safe relative redirect.
  - `/signup`: Username policy helper (3-32 alphanumeric/dashes), password policy helper (12-128 chars, no username), 10 recovery codes display.
  - `/dashboard`: Resumes list (status badges: `Uploading`, `Processing`, `Parsed`, `Failed`, ATS score badge, relative dates, delete with confirmation modal, auto-polling with bounded backoff for `PROCESSING` resumes), `ResumeUpload` dropzone (PDF/DOCX, 5 MB pre-check, presigned storage PUT with progress and cancel support, 429 storage quota banner), and `UsagePanel`.
  - `/account`: User profile, plan badge, usage summary link, `UsagePanel`, and Danger Zone with typed "DELETE" + password confirmation modal calling `DELETE /v1/account`.
- **Usage Panel:** Displays all 3 meters (`analyses`, `job_suggestions`, `resume_storage_bytes`), human units for bytes, reset dates, and distinct, separate alert banners for 50%, 70%, 90%, and 100% (blocked). Unlimited plan renders no alert banners. Refetches after upload/delete and on window focus.
- **Security:** Zero `dangerouslySetInnerHTML` in source files (enforced by ESLint and regression test), strict CSP headers, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, open-redirect sanitization.

### Phase 8B / 8C: Analyze Flow, Match Visualizer, Suggestions UI & Bullet Editor [PLANNED]
1. **Analyze flow:** pick a resume, optionally paste/upload a JD. With a JD: match score, **ATS score**, structured explanation (matched/partial/missing skills, strengths, gaps, prioritized fixes with evidence), suggested jobs. Without a JD: **ATS score**, resume fixes, suggested roles/jobs.
2. Match visualizer: lexical / semantic / cross-encoder / skill breakdown, missing keywords.
3. Interactive bullet editor: side-by-side diff, grounded-evidence highlights.
4. Plain language copy and progressive enhancement.

---

## 10. Phase 9: Security audit and hardening

A dedicated, evidence-based audit of the whole system (not only per-phase checks).
1. Threat model (assets, trust boundaries, abuse cases) written to `docs/SECURITY.md`.
2. **AuthN/AuthZ:** full IDOR matrix over every endpoint; session and CSRF review; rate limits.
3. **Input/upload:** validation, magic bytes, size limits, decompression/zip-bomb and malformed PDF/DOCX handling, optional malware scanning, OCR resource limits.
4. **Transport/headers:** HTTPS, HSTS, CSP, `helmet`-style headers, strict CORS, cookie flags.
5. **Injection:** SQL (parameterized everywhere, review raw SQL in ML code), prompt injection, SSRF (Firecrawl), XSS, log injection.
6. **Secrets and config:** no secrets in git history or images; separate dev/prod config; rotation plan.
7. **Dependencies and containers:** `npm audit`, `pip-audit`, image scanning, non-root containers, minimal images, pinned versions.
8. **Data protection:** PII minimization, retention and deletion verified end-to-end, backups and restore tested, no PII in logs, encryption in transit (and at rest on managed services).
9. **Automated scan:** OWASP ZAP baseline against the running stack; checklist mapped to OWASP ASVS (level 2 target).
10. Every finding is fixed or documented with an accepted-risk note; re-test after fixes.
**Acceptance:** audit report with findings, fixes, and evidence; zero open critical/high items.

---

## 11. Phase 10: Performance, observability, CI, deployment

1. **k6 load test:** p95 latency and throughput for upload, match, analysis; results recorded.
2. Memory profiling and sizing (worker 1.5-2 GB), OCR limits, concurrency settings.
3. Status state machine documented and tested; **dead-letter queue** and retry policy for every queue; idempotency keys.
4. OpenTelemetry traces across Node, Redis, Python, LLM; metrics and structured logs; cost and token dashboards.
5. **CI pipeline:** lint, types, tests, migration check, and the **eval suite as a gate** (a retrieval change that drops accuracy fails the build); fix the E2E environment so it runs cleanly in CI.
6. `render.yaml`, Cloudflare R2, managed Postgres (pgvector) and Redis, production secrets.
7. One-command `docker compose up` for local; README with architecture diagram; deployed demo.
8. Parsing-accuracy measurement (DOCX, text PDF, scanned PDF) against ground truth.
9. Grow the evaluation set to 100+ pairs, always labeled synthetic.

---

## 12. Phase 11: Google OAuth, payments, plans (OPTIONAL, only after Phases 1-10)

1. **Google OAuth** login added alongside username/password (optional).
2. **Payments and plans** (optional; builds on Phase 6): payment provider integration, plans mapped to limits (resume storage, analyses, job suggestions), signature-verified idempotent webhooks, invoices, downgrade/overage behavior.
3. If either is built, re-run the Phase 9 security checks for the new surfaces (OAuth callback, payment webhooks).

---

## 13. Requirement traceability (nothing dropped)

| Requirement | Phase |
|---|---|
| Individual accounts; username/password now | 5 |
| Google OAuth (optional) | 11 (optional) |
| Unlimited uploads and questions | Default everywhere |
| Usage limits displayed | 6 (required) |
| Payment and plans (optional) | 11 (optional) |
| One resume against any number of JDs | 3B (done), 8 |
| Resume + JD gives match score | 3B (done), 3C, 4A, 8 |
| Clear, structured AI response anyone can understand | 4A, 8 |
| 50% / 70% / 90% alerts shown separately | 6, 8 |
| Job suggestions via Firecrawl (temporary), metered with alerts | 7, 6 |
| Payment for job suggestions (optional) | 11 (optional) |
| No JD: fixes, improvements, which job to apply for | 4C, 8 |
| ATS score every time | 2C (done), 4A, 4C, 8 |
| UI white + near-black + green, all pages | 8 |
| Scores by ML only, never the LLM | Rule 11, 4A, 7 |
| Fully secure app + security audit | Rule 12, every phase, 9 |
| Evaluation, ablation, recalibration, alias map | 3C |
| Faithfulness, injection test, PII redaction, bias handling | 4A, 4B |
| LLM-only baseline, token/cost tracking | 4A |
| k6, OTel, CI-gated eval, DLQ, README, deployed demo | 10 |
| Parsing accuracy; dataset 100+ pairs | 10 |
| Worker memory 1.5-2 GB | 10 |
| Resume bullets only after measurement | 3C, 10 |

---

## 14. Open decisions (record answers in the spec)

1. LLM provider and budget (affects 4A and the LLM-only baseline).
2. Password reset method (email vs recovery codes) in Phase 5.
3. Usage period for meters (monthly vs lifetime) and the initial limit values. Real users are unlimited for now; a demo/test plan with low limits is used to show the alerts.
3b. Whether to build the optional Phase 11 (Google OAuth, payments) at all. Default: no.
4. Whether the recruiter-side "one job vs many resumes" mode is ever needed (default: no).
5. Exact meaning of "suggest jobs": this roadmap provides suggestions in **both** cases (with JD: similar jobs; without JD: roles to apply for). Confirm.
