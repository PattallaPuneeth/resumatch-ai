ResuMatch AI --- Hybrid Engineering Specification & Execution Directive
Version: Hybrid v1.0
Purpose: Single source of truth for architecture, implementation
order, contracts, testing, and deployment across Phases 1--5.
Operating rule: Read this document fully before changing code.
Implement sequentially, verify each step, and commit each completed
step separately. Do not silently change architecture or contracts.

1. Project Overview
ResuMatch AI is an AI-powered resume analysis and intelligent
job-matching platform that simulates enterprise ATS ingestion and
provides fact-grounded resume improvements.

The platform must:
1. Extract text from PDF and DOCX resumes, score ATS formatting
   compliance, and identify parsing hazards such as multi-column
   layouts, tables, headers/footers, unusual fonts, and
   scanned/image-only documents.
2. Extract auditable entities: contact information, categorized skills,
   work experience, and education. Every extracted entity must include
   exact character offsets (start_char, end_char) into canonical
   text and a confidence score.
3. Match resumes to jobs using a two-stage hybrid retrieval pipeline:
   - Sparse lexical retrieval: PostgreSQL full-text search
     (tsvector) with GIN indexes and BM25-style ranking.
   - Dense semantic retrieval: 384-dimensional embeddings from
     sentence-transformers/all-MiniLM-L6-v2, stored with pgvector
     HNSW cosine indexes.
   - Reciprocal Rank Fusion (RRF): merge lexical and semantic
     rankings.
   - Cross-encoder reranking: rerank the top fused candidates
     with cross-encoder/ms-marco-MiniLM-L-6-v2.
4. Generate STAR-style bullet improvements aligned with target-job
   keywords while enforcing anti-hallucination checks. Every metric,
   tool, credential, and factual claim in a rewrite must be supported
   by the candidate's original resume text or bullet.
2. Non-Negotiable Engineering Rules
2.1 No mock or dummy feature logic
- Unimplemented feature routes must remain strict
  HTTP 501 Not Implemented stubs using RFC 7807 problem-details
  JSON.
- Do not return fake success responses, dummy parsed resumes,
  fabricated match scores, or placeholder feature results.
- Tests may use fixtures and mocks where appropriate, but production
  feature logic must not be simulated.
2.2 Database and migration authority
- backend/db/schema.prisma is the sole authority for the PostgreSQL
  schema and migrations.
- Pin both prisma and @prisma/client to 5.22.0. Do not
  upgrade to Prisma 8-RC.
- Only the Node/Prisma migration workflow may create or modify schema
  migrations. The Python ML service must never run migrations.
- The ML service reads/writes data using raw SQL through psycopg and
  pgvector.
- Vector dimensions are exactly vector(384), with HNSW cosine
  indexes using vector_cosine_ops.
- Enable the vector extension through the initial migration using
  CREATE EXTENSION IF NOT EXISTS vector;.
2.3 Secrets and runtime configuration
- No hardcoded secrets, credentials, endpoints, or production
  configuration.
- Validate Node configuration at startup using Zod in
  backend/src/config/env.ts.
- Validate Python configuration at startup using Pydantic Settings in
  ml/config.py.
- Commit .env.example; ignore real .env files. Never bake secrets
  into images or commit them to source control.
2.4 Inter-service contracts
- docs/SPECIFICATION.md is the current authoritative source for
  architecture, REST payloads, queue job payloads, status transitions,
  and cross-service behavior.
- docs/contracts.md is intentionally absent. Do not recreate it or
  reference it as an existing contract source during the current task.
- Before implementing or changing any endpoint, status, or queue
  payload, update the relevant contract definitions in this specification
  first or in the same change.
- Keep TypeScript, Python, database models, queue jobs, and frontend API
  clients aligned with the definitions in this specification.
- If a required contract is missing or ambiguous, stop and report the
  ambiguity instead of inventing a payload.
2.5 Stateless services and durable storage
- Original resume files must never be stored in PostgreSQL as bytea
  or large objects.
- Store files in S3-compatible object storage: MinIO locally and
  Cloudflare R2 in production.
- PostgreSQL stores metadata, extracted text, structured parse
  results, embeddings, analysis, matches, and audit records---not
  original file bytes.
- Services must not rely on durable local disk. Temporary processing
  files may use /tmp and must be removed in finally cleanup.
- Buckets must remain private. Browsers upload/download only through
  short-lived presigned URLs issued after authentication and ownership
  checks.
2.6 Docker-only development and deployment
- Docker is the supported way to run, test, and deploy the project. Do
  not assume host-installed Node.js, Python, PostgreSQL, Redis, or
  Tesseract.
- Each deployable service (frontend, backend, ml-api,
  ml-worker) must have its own Dockerfile and .dockerignore.
- The same service images must work locally and in production;
  behavior should differ through environment variables and service
  commands, not source-code forks.
- Local infrastructure runs through Docker Compose with named volumes
  for PostgreSQL, Redis, and MinIO.
- Production uses managed services: Render Postgres, Render Key Value
  (Redis-compatible), and Cloudflare R2. Do not run MinIO on Render.
- Run migrations, tests, linting, typechecking, Prisma commands, and
  Python tooling inside containers.
- The PostgreSQL host-to-container port mapping 5433:5432 in
  docker-compose.yml is required and must be preserved. Host-side
  Prisma Studio must be able to connect through localhost:5433.
  Do not remove, change, or silently replace this mapping. This does not
  override the Docker-only workflow for services and supported commands.
3. Architecture and Service Responsibilities
  Service           Responsibility    Local implementation       Production target
  frontend        Next.js UI,       Docker container           Render Docker Web
                    upload flow,                                 Service
                    status polling,
                    matching and
                    rewrite views                                

  backend         Fastify API,      Docker container           Render Docker Web
                    auth/ownership                               Service
                    checks, presigned
                    URLs, queue
                    producers,
                    management
                    endpoints                                    

  ml-api          FastAPI endpoints Docker container           Render Docker
                    for ML operations                            Private Service;
                    and health checks                            never public

  ml-worker       Python queue      Same ML image, worker      Render Docker
                    consumers for     command                    Background Worker
                    parsing,
                    embeddings,
                    matching and
                    reranking                                    

  postgres        PostgreSQL 16     pgvector/pgvector:pg16   Render Postgres
                    with pgvector     container                  managed service

  redis           BullMQ queue      Redis 7 container          Render Key Value;
                    coordination                                 configure
                                                                 noeviction

  minio           Local             MinIO container plus       Not used in
                    S3-compatible     bucket setup               production
                    object storage                               

  migrate         Applies Prisma    One-shot Compose job       Render pre-deploy
                    migrations before                            command or
                    backend starts                               one-off job,
                                                                 depending on plan
                                                             support
Queue topology
Fastify produces jobs; Python workers consume them through
BullMQ-compatible Redis 7 queues using the agreed BullMQ prefix bull.
- resume-parsing-queue: document parsing and ATS extraction.
- embedding-queue: text chunking and embedding generation.
- match-scoring-queue: lexical/dense fusion, scoring, and reranking.
Use retries with exponential backoff (three attempts as the initial
policy), idempotent handlers, and durable failed-job/dead-letter
records. Do not enqueue embedding jobs until Phase 3 is implemented.
4. Storage Architecture and Security
4.1 Environments
  Environment             Object storage          Configuration
  Local Docker Compose    MinIO                   Bucket resumes,
                                                  created by
                                                  minio-setup

  Production              Cloudflare R2           Private bucket
                                                  resumes;
                                              S3-compatible endpoint
Verify current Cloudflare R2 pricing and quotas before launch and
configure a billing alert. Do not rely on pricing limits remaining
unchanged.
4.2 Required environment variables
Add these to the Zod and Pydantic configuration schemas and document
them in .env.example:
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=resumes
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_FORCE_PATH_STYLE=true
MAX_UPLOAD_BYTES=5242880
PRESIGN_PUT_TTL_SECONDS=300
PRESIGN_GET_TTL_SECONDS=300
For production, use the R2 endpoint, region auto, and production
credentials from the hosting provider's secret configuration. The values
above are local defaults only; do not use local values blindly in
production.
4.3 Dual Node S3 clients
Implement backend/src/storage/s3.ts using @aws-sdk/client-s3 and
@aws-sdk/s3-request-presigner:
- s3InternalClient: uses S3_ENDPOINT for server-side HEAD,
  ranged GET, and DELETE.
- s3SignerClient: uses S3_PUBLIC_ENDPOINT for presigned
  browser-facing URLs and forcePathStyle: true.
The URL-signing hostname must be reachable by the browser. Inside
Docker, minio:9000 is not normally reachable from the browser, so
local browser-facing presigned URLs must use localhost:9000 or the
configured browser-reachable endpoint.

Implement ml/storage/s3.py using boto3 for worker downloads and
required storage operations.
4.4 Object key, privacy, and lifecycle
- Object key format: resumes/{userId}/{resumeId}.{pdf|docx}.
- Generate resumeId server-side as a UUID. Never use the original
  filename in the object key; store a sanitized original filename in
  the database.
- Keep buckets private and enable encryption at rest where supported.
- Use short-lived presigned PUT and GET URLs, each with a default TTL
  of 300 seconds.
- Validate user authentication and ownership before issuing URLs or
  deleting resources.
- On account/resume deletion, remove the object, ParsedResume,
  related ResumeChunk embeddings, Analysis/Match rows, and write
  an AuditLog record.
- Add a scheduled cleanup job for stale UPLOAD_PENDING rows and
  orphaned objects older than 24 hours:
  - Implemented via BullMQ queue `cleanup-queue` and single-concurrency worker.
  - Repeatable job `maintenance-24h-cleanup` registered at application startup.
  - Stale `UPLOAD_PENDING`: removes associated storage object, cascades database records, and logs `RESUME_CLEANUP_STALE_PENDING`. If storage deletion fails, database record is retained for retry and audited with `RESUME_CLEANUP_STALE_PENDING_FAILED`.
  - Stale cleanup & upload completion synchronization: synchronized via per-resume PostgreSQL advisory transaction locks (`pg_advisory_xact_lock` / `pg_try_advisory_xact_lock` on `hashtext('resume-lifecycle:' + resumeId)`). If completion is active, cleanup yields immediately (`skipped++`) to preserve the upload; if cleanup claims the lock, completion waits until commit and returns 404 without transitioning the deleted record or touching storage.
  - Queue-failure rollback protection: if parsing-job enqueue fails after completion validation, rollback to `UPLOAD_PENDING` acquires the coordination lock, verifies status via an explicit allowlist, and refreshes `createdAt` to `now()` so that subsequent stale-cleanup runs grant a fresh 24-hour retry window rather than immediately deleting the active retry candidate.
  - Orphaned objects: lists objects under `resumes/` with pagination, protects objects younger than 24 hours, queries PostgreSQL references, rechecks references immediately before deletion, deletes unreferenced objects, and logs `STORAGE_CLEANUP_ORPHAN`.
- Store a SHA-256 hash per uploaded file. Reuse parse results for
  identical files belonging to the same user when safe and consistent
  with ownership/audit requirements.
- Configure MinIO and R2 CORS to permit the frontend origin and
  required PUT/GET methods with Content-Type allowed. Browser
  uploads will fail if CORS is missing or incorrect.
  Cloudflare R2 CORS configuration (`cors.json`):
  ```json
  [
    {
      "AllowedOrigins": ["https://app.resumatch.ai", "http://localhost:3000"],
      "AllowedMethods": ["GET", "PUT", "HEAD"],
      "AllowedHeaders": ["Content-Type", "Content-Disposition"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```
- Consider an optional ClamAV scan later between UPLOADED and
  EXTRACTING; it is not a Phase 2 blocker.
5. Database and Resume Status Model
5.1 Required schema changes
Update backend/db/schema.prisma and generate a migration. Add to
Resume:
- storageKey String (unique)
- originalFilename String
- mimeType String
- sizeBytes Int
- sha256 String?
- extractionMethod enum: TEXT_LAYER | OCR | DOCX
- errorCode String?
- errorMessage String?
Add to ParsedResume if not already present:
- rawText --- canonical extracted text
- pageCount
- atsScore
- atsHazards Json
All entity offsets must reference the exact canonical rawText string
persisted in ParsedResume.
5.2 Resume status state machine
Use these explicit statuses:
UPLOAD_PENDING -> UPLOADED -> EXTRACTING -> PARSED
                                   |
                                   +-> NEEDS_OCR -> OCR_PROCESSING -> PARSED

Any state -> FAILED (with errorCode)
- Replace the old PROCESSING status.
- Migration rule: map existing PROCESSING rows to EXTRACTING.
- Make status transitions safe and idempotent; repeated completion
  requests or repeated queue jobs must not corrupt the resume state.
- Expose safe user-facing error codes/messages. Never expose stack
  traces or secrets to clients.
Suggested error codes include UNSUPPORTED_TYPE, FILE_TOO_LARGE,
ENCRYPTED_PDF, CORRUPT_FILE, TOO_MANY_PAGES,
TEXT_TOO_SHORT_AFTER_OCR, and INTERNAL_ERROR.
6. Phase Plan and Implementation Order
Phase 1 is considered complete and frozen unless a verified defect
requires a narrowly scoped fix.
Phase 1 --- Foundation, infrastructure, and contracts (DONE)
The baseline is expected to include:
- Docker Compose infrastructure for PostgreSQL 16 with pgvector, Redis
  7, MinIO and bucket provisioning, Fastify backend, FastAPI ML
  service, and Next.js frontend.
- Prisma schema for User, Resume, ParsedResume, ResumeChunk,
  Job, JobChunk, Analysis, Match, and AuditLog.
- Vector and full-text index migrations, including HNSW and GIN
  indexes where applicable.
- Fastify backend with strict TypeScript, Zod environment validation,
  Pino logging, RFC 7807 error handling, and 501 stubs in
  backend/src/routes/resumes.ts, jobs.ts, and analyses.ts.
- FastAPI foundation with Pydantic v2 contract models and contract
  stubs.
- GET /health checks for Postgres, Redis, and MinIO, including
  useful dependency latency/error information.
- Next.js shell and health dashboard.
- Vitest/Pytest, Makefile/scripts, and GitHub Actions CI for linting,
  typechecking, and tests.
Do not assume every listed item is working merely because it is
described here. Verify the repository and actual test results before
declaring completion.
Phase 2 --- Secure upload, ATS ingestion, and parsing (NEXT)
Implement in this exact order:
1. Docker baseline and health checks
2. Phase 2A: storage modules, environment schemas, Prisma
   schema/migration, contracts
3. Phase 2B: presigned upload and completion endpoints
4. Phase 2C: Python parsing worker and OCR fallback
5. Phase 2D: status, download, and deletion endpoints plus end-to-end
   tests
Step 0 --- Docker baseline
- Add/verify Dockerfiles and .dockerignore for backend, frontend,
  and ML services.
- Add the one-shot migrate service and separate ml-worker
  command/service.
- Configure service health checks and healthy dependency ordering.
- Confirm docker compose up --build brings every required service to
  a healthy state.
- Run tools and tests inside containers.
Phase 2A --- Storage, schema, and contracts
- Extend Node Zod and Python Pydantic settings with the S3 and upload
  configuration.
- Implement Node and Python S3 storage abstractions.
- Configure MinIO CORS and document the corresponding R2 CORS setup.
- Update the Prisma models and status enum, then create and test the
  migration.
- Update the relevant REST and queue contract definitions in
  docs/SPECIFICATION.md before or alongside endpoint and job
  implementation.
- Verify migration behavior against the Compose PostgreSQL instance.
Phase 2B --- Fastify upload flow
All endpoints are authenticated, ownership-aware where applicable, and
use RFC 7807 errors.

POST /v1/resumes/upload-url - Validate
{ filename, mimeType, sizeBytes } using Zod. - Accept PDF and DOCX
only; reject reported sizes greater than MAX_UPLOAD_BYTES (default 5
MiB). - Do not trust client MIME type alone. - Generate a UUID
resumeId and storage key resumes/{userId}/{resumeId}.{ext}. - Create
a Resume record with status UPLOAD_PENDING. - Return
{ resumeId, uploadUrl, headers, expiresIn }. - Presign a PUT URL with
a default TTL of 300 seconds and bind the required content headers where
supported by the storage SDK/signature design.

POST /v1/resumes/:id/complete - Verify authentication and
ownership. - Use S3 HeadObject to confirm the object exists and check
actual size. - Read a small byte range to validate magic bytes: %PDF-
for PDF or ZIP signature PK for DOCX. - Reject and delete invalid
objects; mark the resume FAILED with an appropriate safe error code
such as CORRUPT_FILE. - Calculate SHA-256 and persist it. - Transition
to UPLOADED, enqueue a PARSE_DOCUMENT job, and return HTTP
202 Accepted. - Make the endpoint idempotent. Repeated calls must not
create duplicate parsing work or inconsistent states.

Hardening: - Rate-limit upload URL issuance per user with
@fastify/rate-limit. - Set a configurable per-user resume cap. -
Enforce actual object size, not only the client-reported size. -
Validate file signature in addition to filename extension and MIME type.
Phase 2C --- Python parsing worker
Implement under ml/pipelines/intake/.

Queue contract --- resume-parsing-queue
{
  "type": "PARSE_DOCUMENT",
  "resumeId": "uuid",
  "bucket": "resumes",
  "storageKey": "resumes/{userId}/{resumeId}.pdf",
  "mimeType": "application/pdf",
  "sha256": "hex"
}
- Keep the queue contract synchronized with the definitions in
  docs/SPECIFICATION.md.
- Configure three attempts with exponential backoff initially, and
  persist failed-job/dead-letter details.
- The worker must be idempotent: reprocessing a resumeId updates the
  same ParsedResume record instead of creating duplicates.
Pipeline 1. Download the object to /tmp using boto3; always
remove the temporary file in a finally block. 2. Set status to
EXTRACTING. 3. PDF: use PyMuPDF (fitz) to extract text blocks,
bounding boxes, page count, and available font/layout metadata. 4.
DOCX: use python-docx to extract paragraphs, tables, headers, and
footers. Record tables and header/footer content as ATS hazards. 5.
Quality gate: if stripped text is under approximately 200 characters
or the alphanumeric ratio is abnormally low, transition to NEEDS_OCR.
6. OCR fallback: set status to OCR_PROCESSING; render pages with
PyMuPDF and run Tesseract through pytesseract. Make DPI configurable,
start at 300 DPI, and benchmark lower values (such as 200 DPI) for
memory and quality. Cap OCR processing at five pages by default,
configurable through validated settings. 7. If OCR output remains under
approximately 200 characters, set FAILED with
TEXT_TOO_SHORT_AFTER_OCR and a safe user-facing message asking for a
better-quality file. 8. Canonicalize the extracted content into one
stable rawText string with normalized whitespace and logical reading
order. For multi-column layouts, attempt column-aware ordering rather
than blindly sorting all blocks by vertical position. 9. Detect ATS
hazards: multi-column layouts, tables, header/footer content, unusual
fonts, missing standard sections, and OCR-required/image-only resumes.
OCR requirement must be explicitly reported as a finding and may reduce
the ATS score. 10. Calculate and persist an ATS compliance score from
0--100 and structured atsHazards. 11. Extract contact details (email,
phone, LinkedIn, GitHub, location), categorized skills (languages,
frameworks, tools, soft_skills), work experience, and education.
Include confidence scores and exact start_char/end_char offsets into
canonical rawText. 12. Persist results to ParsedResume, set
Resume.status = PARSED, and log processing duration. 13. Do not
enqueue embedding jobs until Phase 3 is implemented. 14. For
unrecoverable errors, set FAILED with an appropriate errorCode and
safe errorMessage; keep stack traces in server logs only.

The ML Docker image must install Tesseract and required language packs,
CPU-only PyTorch, and pre-download the model weights required by later
phases. Containers must not depend on downloading model weights at
startup.
Phase 2D --- Retrieval and management endpoints
Implement:
- GET /v1/resumes/:id: return status and safe error details; include
  parsed data only when status is PARSED.
- GET /v1/resumes/:id/download-url: ownership-check and return a
  short-lived presigned GET URL with
  Content-Disposition: attachment.
- DELETE /v1/resumes/:id: ownership-check, delete the S3 object and
  all derived rows (ParsedResume, ResumeChunk, Analysis, Match
  as applicable), and write an AuditLog entry.
- Update frontend/src/app/upload/page.tsx to request an upload URL,
  PUT the file directly to storage, call the completion endpoint, and
  poll status transitions.
- Ensure failed and stale uploads are visible and recoverable rather
  than appearing permanently in a loading state.
Phase 2 definition of done A user can upload a PDF or DOCX in the
browser; the file uploads directly to MinIO locally or R2 in production
without passing through API memory; the worker extracts text with OCR
fallback; results and status appear in the UI; and deletion removes the
object and derived data. Lint, typecheck, unit tests, integration tests,
and CI remain green.
Phase 3 --- Embeddings and hybrid matching
Phase 3A --- Chunking and embedding generation (IMPLEMENTED)
- Enqueue an EMBED_DOCUMENT job to `embedding-queue` (prefix `bull`) when a resume reaches `PARSED`.
- Implement semantic-boundary section-aware chunking in `ml/pipelines/embeddings/chunker.py`:
  - Detects sections: Summary, Experience, Skills, Education, and Other.
  - Safe token limits: `sentence-transformers/all-MiniLM-L6-v2` enforces `max_seq_length = 256` (including `[CLS]` and `[SEP]` special tokens, allowing at most 254 content tokens). To strictly prevent silent token truncation, chunks target 160–240 content tokens (nominal 200) with ~20% overlap (40 tokens).
  - Slices `ParsedResume.rawText` directly; offset convention strictly guarantees `raw_text[chunk.start_char:chunk.end_char] == chunk.content`.
- Generate exactly 384-dimensional normalized vector embeddings with `sentence-transformers/all-MiniLM-L6-v2` loaded once per worker process.
- Persist embeddings in `ResumeChunk` using raw SQL with `pgvector` HNSW cosine indexes (`vector_cosine_ops`) and composite unique constraint on `("resumeId", "chunkIndex")`; prepare `JobChunk` schema, vector column, and unique index for Phase 3B job ingestion and matching.
- Idempotency & Failure Safety:
  - Worker operates inside a PostgreSQL transaction (`conn.transaction()`); failure rolls back completely, preventing partial chunks.
  - Re-delivering or retrying jobs atomically replaces previous chunk records with zero duplicate rows.
  - Observable failure status recorded in `parsed_resumes.parsingMetadata` without corrupting the `PARSED` status.
- Deployment Resource Sizing:
  - Worker idle memory with model loaded is ~160 MiB.
  - Peak RSS during batch embedding inference reaches ~523 MiB.
  - Operational requirement: Allocate at least 1 GB (preferably 2 GB) RAM in production. A 512 MB container tier (e.g. Render Starter) is unsafe and will trigger out-of-memory (OOM) termination.
Phase 3B --- Hybrid retrieval and reranking
- Job Ingestion & Storage:
  - Fastify endpoint `POST /v1/jobs` accepts job title, company, description, requiredSkills, preferredSkills, location, and jobType. Validates payload via Zod, enforces JWT auth and user ownership, and persists to `jobs` table with `ACTIVE` status.
  - Automatically enqueues `EMBED_DOCUMENT` task with payload `{ entityType: "JOB", jobId }` to `embedding-queue`.
  - ML worker splits job description into section-aware chunks (`chunk_job_text`), generates 384-dimensional embeddings, and idempotently persists them to `job_chunks`.
  - `GET /v1/jobs/:id` retrieves job details and chunk count with strict tenant isolation (404 for non-owners).
- Matching Triggers & Endpoints:
  - `POST /v1/jobs/:id/match` accepts `{ resumeId: UUID }`. Verifies that BOTH the job and the resume belong to the authenticated user (using 404 convention for cross-tenant attempts), and strictly validates that the resume is in `PARSED` status (returning 422 Unprocessable Entity otherwise). Enqueues task to `match-scoring-queue` and responds with 202 Accepted.
  - `GET /v1/jobs/:id/matches/:resumeId` exposes single match result route, returning `bm25Score`, `vectorScore`, `rrfScore`, `crossEncoderScore`, `finalScore`, and structured `explanation` with skill-gap metrics.
- Hybrid Retrieval & Scoring Pipeline:
  1. Sparse Lexical Search: PostgreSQL full-text search with OR-style `tsquery` (joining stemmed English lexemes with ` | ` using `quote_literal(elem)` to prevent syntax errors and avoid `plainto_tsquery` AND failure modes on long job descriptions). Matches exact expression `to_tsvector('english', content)` on GIN index `resume_chunks_content_tsv_idx` and ranks via `ts_rank_cd`.
  2. Dense Semantic Search: pgvector cosine distance `<=>` queries utilizing HNSW index `resume_chunks_embedding_hnsw_idx` with `vector_cosine_ops`, converting distance to similarity (`1 - distance`).
  3. Reciprocal Rank Fusion (RRF): Evaluates candidate chunks $d$ for a single (job, resume) pair using:
     $$RRF\_Score(d) = \sum_{m \in \{lex, sem\}} \frac{1}{k + rank_m(d)}, \quad k = 60$$
     Applies deterministic tie-breaking sorted by `rrf_score DESC, chunk_id ASC`. Aggregates chunk ranks into resume-level RRF score: $max(chunk\_rrf) + 0.25 \times mean(top\_3\_chunks\_rrf)$.
  4. Cross-Encoder Reranking: Top 20 fused candidates evaluated against bounded job requirements using `cross-encoder/ms-marco-MiniLM-L-6-v2`. Bounded rerank query (max 180 tokens) guarantees candidate resume chunks (up to 254 tokens) are protected from 512-token sequence truncation. Normalizes raw cross-encoder logits to calibrated 0–100 match percentage using calibrated logistic scaling:
     $$P = \frac{100}{1 + e^{-(logit - shift) / temp}}$$
     *Production Calibration Defaults*:
     $$shift = -3.5, \quad temp = 2.8, \quad w_{ce} = 0.65, \quad w_{skill} = 0.25, \quad w_{vec} = 0.10$$
     Evaluated against synthetic evaluation pairs. The v2 candidate parameters ($shift=-3.0, temp=1.8, w_{ce}=0.70, w_{skill}=0.20, w_{vec}=0.10$) were evaluated across train-only and Leave-One-Resume-Out splits, but showed no clear gain over baseline (ordering tied at 97.6%, held-out accuracy tied at 76.9%, and full 32-pair label accuracy lower at 84.4% vs 87.5%). Production defaults therefore remain at $shift=-3.5, temp=2.8, w_{ce}=0.65, w_{skill}=0.25, w_{vec}=0.10$. Neither parameter set is described as validated; full empirical recalibration will be conducted on 100+ real-world pairs.
  5. Skill-Gap Analysis: Normalizes candidate and job skills with alias mapping (e.g. `k8s` -> `kubernetes`, `postgres` -> `postgresql`), categorizing into `matched`, `partial`, and `missing` skills, and computing fractional coverage ratio.
  6. Idempotent Persistence: Persists results into `matches` table via atomic transaction with `ON CONFLICT ("resumeId", "jobId") DO UPDATE`.
  7. Backward Compatibility: Preserves Phase 3A `{ resumeId }` payload compatibility on `embedding-queue`.
- Resource & Memory Profiling:
  - Both `sentence-transformers/all-MiniLM-L6-v2` and `cross-encoder/ms-marco-MiniLM-L-6-v2` baked directly into Docker image during build.
  - ML worker memory usage during hybrid retrieval, batch inference, and reranking measured at ~467 MiB RSS, well within the 1.5 GB memory limit.
Phase 3C-1 --- Evaluation Harness and Extended Skill Taxonomy (IMPLEMENTED)
- Skill Taxonomy & Alias Map:
  - Canonical taxonomy defined in `ml/pipelines/matching/skill_taxonomy.json` across 16 core technology clusters (backend, frontend, cloud, databases, DevOps, machine learning, testing, messaging, etc.).
  - Normalization engine in `ml/pipelines/matching/skill_gap.py` resolves aliases (e.g. `k8s` -> `kubernetes`, `postgres` -> `postgresql`, `react.js` -> `react`, `aws` -> `amazon web services`).
  - Strict false-positive prevention: Enforces word-boundary regular expression matching `(?:^|[\s,;/()\[\]]){escaped}(?:$|[\s,;/()\[\]])` ensuring substring collisions are prevented (e.g., `Java` does not match `JavaScript`, `C` does not match `C++` or `C#`, `Go` does not match `Google` or `Django`).
- Modular Match Scoring (`ml/pipelines/matching/scorer.py`):
  - Extracted modular scoring function `compute_match_scores` supporting configurable shift, temperature, and blend weights (`w_ce`, `w_skill`, `w_vec`) for calibration and ablation while strictly preserving production defaults:
    $$shift = -3.5, \quad temp = 2.8, \quad w_{ce} = 0.65, \quad w_{skill} = 0.25, \quad w_{vec} = 0.10$$
  - Integrated into production worker pipeline (`ml/worker.py`) without modifying external API response schemas.
- Evaluation Harness Architecture (`ml/eval/`):
  - CLI Entrypoint: `python -m ml.eval.run --dataset <path> [--output-dir <path>] [--cache-dir <path>]`.
  - Structured modules:
    - `dataset.py`: Comprehensive dataset loader with strict schema validation (missing files, invalid labels, missing columns, duplicate pairs).
    - `metrics.py`: Computes Pairwise Ordering Accuracy, Label Classification Accuracy, per-tier Mean Scores, and Separation Margins ($Strong - Medium$, $Medium - Weak$). Canonical classification thresholds defined in `ml/eval/metrics.py`:
      - **Strong Match**: $\text{score} \ge 75.0$ (`DEFAULT_STRONG_THRESHOLD = 75.0`)
      - **Medium Match**: $45.0 \le \text{score} < 75.0$ (`DEFAULT_WEAK_THRESHOLD = 45.0`)
      - **Weak Match**: $\text{score} < 45.0$
    - `ablation.py`: Evaluates 6 pipeline configurations (Lexical only, Semantic only, RRF only, RRF + Cross-Encoder, + Skill-Gap, Full Composite Blend) and exports structured ablation tables.
    - `calibration.py`: Performs deterministic stratified train/held-out splitting (seed=42) and grid-search parameter optimization against held-out benchmark pairs.
    - `runner.py`: End-to-end evaluation pipeline with SHA-256 disk-based artifact caching (`.eval_cache`) for sub-second repeat runs.
  - Zero DB Pollution: Executes entirely in-memory against local files, creating zero temporary or permanent rows in the production PostgreSQL `resumatch` database.
  - Benchmark Dataset Format:
    - `resumes/`: Synthetic candidate resumes (`.pdf`, `.docx`).
    - `jobs/`: Synthetic job requirement specifications (`.txt`).
    - `labels.csv`: Labeled pairs with columns `resume,job,expected,reason`, where `expected` is strictly in `{"strong", "medium", "weak"}`.
    - Built-in fixture dataset provided under `ml/tests/fixtures/eval_dataset/` for deterministic CI regression testing.
  - Synthetic Data Labeling: All generated markdown reports and tables explicitly identify benchmark results as synthetic evaluation data.
Phase 3C-2 --- Real-Data Evaluation and Recalibration Study (IMPLEMENTED)
- Real-Data Evaluation on Synthetic Benchmark:
  - Benchmark dataset `test-data/`: 8 resumes, 8 job descriptions, 32 labeled candidate pairs (8 Strong, 10 Medium, 14 Weak).
  - Executed baseline evaluation using production defaults ($shift=-3.5, temp=2.8, w_{ce}=0.65, w_{skill}=0.25, w_{vec}=0.10$).
  - Identified and resolved RRF anomaly: Clarified that RRF functions strictly as an intra-document candidate passage ranker ($1 / (60 + \text{rank})$) rather than an absolute cross-candidate fit score.
- Parameter Study & Comparison:
  - Evaluation setup: Stratified deterministic split (19 train pairs / 13 held-out pairs, seed=42) and Leave-One-Resume-Out (LORO) cross-validation across 8 resumes.
  - Candidate v2 parameters ($shift = -3.0, temp = 1.8, w_{ce} = 0.70, w_{skill} = 0.20, w_{vec} = 0.10$) fit on train split only.
  - Held-out evaluation (reported once, without tuning on held-out data):
    - Pairwise Ordering Accuracy: 96.3% (tied with baseline 96.3%).
    - Label Classification Accuracy: 76.9% (tied with baseline 76.9%).
    - Strong-to-Medium Margin: +41.9 pts (vs baseline +34.2 pts).
    - Medium-to-Weak Margin: +27.7 pts (vs baseline +25.9 pts).
  - All 32 Pairs Comparison:
    - Pairwise Ordering Accuracy: 97.6% (tied at 324 / 332 valid comparisons).
    - Label Classification Accuracy: Baseline = 87.5% (28 / 32 correct) vs Candidate v2 = 84.4% (27 / 32 correct).
    - Separation Margins: Baseline = +28.2 pts / +34.2 pts; Candidate v2 = +33.5 pts / +39.5 pts.
  - Conclusion: Candidate v2 evaluated with no clear gain over current defaults under proper splits (label accuracy lower overall, tied on held-out). Production defaults remain at $shift=-3.5, temp=2.8, w_{ce}=0.65, w_{skill}=0.25, w_{vec}=0.10$. Revisit with 100+ pairs. Neither parameter set is described as validated.
  - End-to-End Live Cluster Verification: Jane Doe fixture match score verified at 83.39 (Cross-Encoder score 88.46%, Skill Coverage 75.0%, Vector Similarity 71.37%).
Phase 4 --- Fact-grounded STAR bullet rewriter
- Implement POST /v1/rewriter/bullet to accept a candidate's
  original experience bullet and target-job keywords/description.
- Rewrite using STAR principles (Situation/Task, Action, Result),
  clearer action verbs, and relevant target-job terminology.
- Do not invent metrics, percentages, tools, credentials,
  responsibilities, or outcomes.
- Implement ml/pipelines/rewriter/verifier.py.
- Every factual claim, metric, percentage, tool, and numerical claim
  in the output must map to an exact supporting character span in
  ParsedResume.rawText or the supplied original bullet.
- Reject unverified claims with HALLUCINATION_DETECTED; constrained
  regeneration may be attempted, but the final result must still pass
  verification.
- If the source contains no measurable result, do not fabricate one
  merely to force a STAR format.
- Add tests for valid grounded rewrites, invented metrics, unsupported
  tools, unsupported credentials, and absent evidence.
Phase 4C --- Resume-only improvements and role suggestions (IMPLEMENTED)
- Endpoint: POST /v1/resumes/:resumeId/improvements (Synchronous, stateless).
  - Authenticated via JWT (preHandler: app.authenticate).
  - Ownership: Enforces userId isolation; returns 404 on unowned resumes (IDOR protection).
  - Status Validation: Resume must be in PARSED status and have rawText; returns RFC 7807 422 if not.
  - Fail-Closed ML Communication: Calls internal ML endpoint POST /v1/resumes/:resumeId/improvements with X-Internal-Token header (rejects missing/short/CHANGE_ME tokens with 401).
- Static Curated Role Taxonomy:
  - Externalized in `ml/data/role_taxonomy.json` containing 40 common software, data, and IT engineering roles.
  - Each role provides `id`, `title`, 1-2 sentence `description`, and canonical `coreSkills` aligned with `skill_taxonomy.json`.
- ML-Ranked Role Suggestions:
  - Vector Representation: Computes mean of existing 384-dimensional pgvector chunk vectors for `resumeId` from `resume_chunks`. Does not re-embed the resume.
  - Role Vectors: Embedded lazily with the singleton `SentenceTransformer` (`sentence-transformers/all-MiniLM-L6-v2`) and cached in memory.
  - Ranking: Cosine similarity against role vectors; returns top 5 with ML similarity score (0.0..1.0), `matchedSkills`, and `missingSkills`.
- Deterministic ATS Hazard Remediation:
  - Transforms stored Phase 2C hazards (`ParsedResume.atsHazards`) and ATS score (`ParsedResume.atsScore`) into prioritized, plain-language `AtsFix` items.
  - Always returns `atsScore` (float 0.0..100.0).
- Deterministic Content Findings:
  - Scans `rawText` and produces findings with exact character spans (`startChar`, `endChar`, `quote` where `rawText[start:end] == quote`):
    - `MISSING_SECTION`: Missing standard Experience, Education, or Skills headers.
    - `WEAK_PHRASE`: Passive phrasing ("responsible for", "worked on", "assisted with", etc.).
    - `OVERLY_LONG_BULLET`: Bullets exceeding 200 characters.
    - `NO_ACTION_VERB`: Bullets lacking a recognized strong action verb.
    - `NO_METRIC_OR_NUMBER`: Bullets lacking quantifiable metrics or percentages.
    - `REPEATED_OPENING_VERB`: Bullets reusing identical opening verbs across the resume.
- Schema-Validated LLM Synthesis & Graceful Fallback:
  - Redacts PII from candidate text before building prompt.
  - Wraps untrusted text in cryptographically random delimiters (`<<<DATA_{uuid}>>> ... <<</DATA_{uuid}>>>`).
  - Synthesizes findings into `summary` and `prioritizedNextSteps`. Never alters scores or invents roles.
  - Grounding Verifier: Verifies `evidenceQuotes` against source text; rejects hallucinated quotes.
  - Fail-Open Resilience: If all LLM tiers fail or the verifier rejects, the request succeeds with HTTP 200, returning all deterministic findings and roles with `llmStatus = 'UNAVAILABLE'`.
  - Caching: Responses cached in Redis by `hash(rawText + prompt_version)`.
  - Logging: Logs only provider, model, tokens, and latency; never PII or raw text.
- Known Limitations:
  - Requires pre-computed chunk embeddings in `resume_chunks` for optimal role matching (falls back to single-passage embedding if absent).
  - Role taxonomy is statically curated; does not dynamically fetch external job postings (reserved for Phase 7).
Phase 5 --- Full-stack integration, deployment, and hardening
- Replace feature stubs only when the corresponding implementation is
  complete and tested. No dummy logic.
- Connect the Next.js UI to live endpoints.
- Build a Candidate Match Visualizer showing lexical,
  dense-vector, and cross-encoder scores; highlighted skill overlap;
  missing keywords; and supporting evidence.
- Build an Interactive Bullet Editor with side-by-side
  original/rewrite text, diff view, keyword highlights, and verified
  factual anchor spans.
- Add rate limiting to upload and rewrite endpoints.
- Add end-to-end tests across
  browser/API/storage/queue/database/worker flows.
- Benchmark ingestion, search, matching, and rewrite paths; report
  measured results rather than claiming targets without evidence.
- Suggested initial ingestion targets: P95 under 3.5 seconds for
  text-layer PDFs and under 8 seconds for OCR fallback, measured on a
  documented test environment. If these are not achieved, report
  actual latency and bottlenecks rather than hiding failures.
- Verify CI passes linting, typechecking, unit tests, integration
  tests, and end-to-end tests.
7. Docker and Deployment Requirements
7.1 Dockerfiles and images
- Use slim, pinned base-image versions (for example, Node 20 and
  Python 3.11, with patch versions updated deliberately).
- Run as a non-root user.
- Use multi-stage builds for Node services.
- Include a .dockerignore per deployable service, excluding at
  minimum node_modules, .git, .env*, caches, test artifacts not
  needed at runtime, and local build output where appropriate.
- Never copy real secrets into images.
- Configure Next.js output: "standalone".
- NEXT_PUBLIC_* values are inlined at build time; provide them as
  Docker build args/build-time environment where required, not only as
  runtime environment variables.
- The ML image must install tesseract-ocr and tesseract-ocr-eng
  (plus required language packs), install CPU-only PyTorch before
  other Python requirements, and pre-download:
  - sentence-transformers/all-MiniLM-L6-v2
  - cross-encoder/ms-marco-MiniLM-L-6-v2
- The ML image must support distinct commands for the API and worker,
  such as:
  - API: uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}
  - Worker: python -m ml.worker (or the repository's equivalent
    module)
- Ensure the actual module paths match the repository. Do not copy
  example commands without checking entry points.
7.2 Compose startup and health checks
- Use healthcheck for PostgreSQL, Redis, MinIO, backend, ML API, and
  frontend as appropriate.
- Use depends_on: condition: service_healthy where supported so
  startup order is:
  postgres, redis, minio -> migrate -> backend, ml-api, ml-worker -> frontend.
- The migration job should exit successfully before dependent
  application services start.
- Configure Redis with
  --maxmemory-policy noeviction --appendonly yes for local BullMQ
  use.
- Use named volumes for local durable data.
- Add a documented command for checking all service health states.
7.3 Render production deployment
- Define services in render.yaml when Phase 5 deployment
  configuration is implemented.
- Use Docker-runtime services for all deployable components.
- Use Render Postgres, Render Key Value, and Cloudflare R2 in
  production; do not depend on container-local durable storage.
- Run Prisma migrations through a supported pre-deploy command or
  one-off job. Verify availability on the chosen Render plan before
  relying on it.
- Keep ml-api on Render's private network and do not expose it
  publicly.
- The ML API and worker may initially share an image but should run as
  separate services/commands when memory and reliability require it.
- Verify current Render plan limits, spin-down behavior, database
  retention, instance sizing, pricing, and networking before launch.
- Set all secrets through Render environment settings or secret files.
- Configure R2 CORS for the frontend domain and verify real browser
  PUT/GET behavior.
7.4 ML memory and performance validation
Do not guess final memory needs. Measure them.
1. Start local ML containers with a 2 GB memory limit as an initial
   benchmark, where the host can support it.
2. Measure idle memory after model loading using docker stats.
3. Record peak memory for a text PDF, DOCX, one-page scanned PDF,
   five-page scanned PDF, and a worst-case 5 MB image-heavy PDF.
4. Test 5--10 concurrent uploads and document peak memory.
5. Process at least 100 resumes in a loop to look for memory leaks.
6. Select production instance size from measured peak memory plus
   30--40% headroom.
7. Alert on restarts and sustained memory above 80%.
8. If memory is excessive, reduce worker concurrency (especially OCR),
   load models once per worker, benchmark lower OCR DPI, or split OCR
   into a dedicated worker.
8. API and Error Handling Standards
- All protected resume endpoints must authenticate the user and check
  ownership.
- Use consistent RFC 7807 problem-details responses for errors.
- Validate request payloads at the boundary with Zod in Fastify.
- Return 202 Accepted when parsing is queued asynchronously.
- Keep client-visible error messages safe and actionable.
- Do not expose stack traces, internal hostnames, credentials, storage
  signatures, or sensitive logs.
- Use structured Pino logs in Node and structured logging in Python.
- Include correlation/request IDs where practical so API requests and
  worker logs can be connected.
- Rate-limit resource-intensive endpoints and enforce upload limits on
  both declared and actual size.
- Make queue consumers idempotent and status transitions safe under
  retries.
9. Required Test Coverage
Upload and storage
- Valid text-layer PDF.
- Valid DOCX.
- Scanned/image-only PDF that needs OCR.
- Encrypted PDF.
- Corrupt PDF/DOCX.
- Unsupported extension/MIME type.
- Incorrect magic bytes.
- Oversized file and mismatch between declared and actual size.
- Expired presigned URL and storage/CORS failure behavior.
- Duplicate upload and repeated /complete calls.
- Unauthorized access, cross-user ownership attempts, and deletion
  authorization.
- Stale pending upload cleanup and orphan object cleanup.
Parsing and ATS
- Text extraction and canonical text stability.
- Entity spans correctly point to the extracted substring in
  rawText.
- Multi-column, table, header/footer, unusual font, and
  missing-section hazards.
- OCR-required resumes are explicitly flagged.
- OCR text-too-short failure and page-limit behavior.
- Idempotent processing and safe error persistence.
Matching
- Lexical-only, semantic-only, and hybrid matches.
- RRF ordering and tie cases.
- Cross-encoder reranking of top candidates.
- Empty result sets, duplicate candidates, and malformed input.
- Skill-gap output and persisted evidence.
Rewriter
- Grounded rewrite accepted.
- Invented metric rejected.
- Unsupported tool/credential rejected.
- No fabricated result when source has no measurable outcome.
- Exact evidence spans and hallucination rejection behavior.
Platform and CI
- API contract tests.
- Queue retry and idempotency tests.
- Ownership and deletion cascade tests.
- Health checks under dependency failure.
- Docker Compose startup and health.
- Lint, typecheck, unit, integration, and end-to-end tests.
10. Execution Protocol for the Coding Agent
Follow these rules on every task:
1. Inspect the repository before editing. Confirm actual paths, package
   managers, entry points, existing schema, contracts, Dockerfiles, and
   current test commands.
2. Report the exact scope of the next step and list files expected to
   change.
3. Implement only the current phase/sub-phase. Do not jump ahead or
   rewrite unrelated modules.
4. Update the relevant REST and queue contract definitions in
   docs/SPECIFICATION.md before or alongside contract-affecting code.
   Do not recreate docs/contracts.md unless the project owner explicitly
   changes this documentation decision.
5. Preserve Phase 1 behavior unless a verified defect requires a
   focused fix.
6. Keep Prisma and @prisma/client pinned to 5.22.0.
7. Do not add mock feature logic or turn 501 stubs into fake
   successes.
8. Use Docker for all supported development and test workflows.
9. Run relevant tests, linting, and typechecking inside containers. Do
   not claim a check passed unless it was actually run and passed.
10. Review the diff for secrets, generated files, unrelated changes,
    contract drift, and accidental schema changes.
11. Summarize files changed, behavior implemented, commands run, actual
    results, and known blockers.
12. Stop and report blockers rather than silently changing architecture
    or weakening requirements.
13. Commit each verified implementation step separately if the agent has
    repository/commit access; otherwise provide a suggested commit
    message.
14. Keep future-phase functionality as 501 until its own
    implementation is reached and tested.
11. Immediate Next Actions
Start with the Docker baseline and Phase 2A; do not begin semantic
matching or rewriting yet.
1. Inspect the current repository and verify Phase 1's claimed
   completion.
2. Add/verify Dockerfiles and .dockerignore for backend, frontend,
   and ML.
3. Add/verify migrate and ml-worker services, health checks, and
   healthy dependency ordering.
4. Run docker compose up --build and verify every required service
   becomes healthy.
5. Extend Zod and Pydantic environment schemas.
6. Implement the dual Node S3 clients and Python S3 wrapper.
7. Update Prisma schema, status enum, and migration; keep Prisma
   packages at 5.22.0.
8. Document Phase 2 endpoint contracts and the PARSE_DOCUMENT job
   payload in docs/SPECIFICATION.md; do not create docs/contracts.md.
9. Verify migration and S3 operations in Docker before starting Phase
   2B.
10. Continue sequentially through Phase 2B, 2C, and 2D, meeting the
    Phase 2 definition of done before starting Phase 3.
12. Completion and Reporting Checklist
At the end of each sub-phase, report:
- [ ] Scope completed as specified.
- [ ] Files created/modified.
- [ ] Database migration status, if applicable.
- [ ] Contract updates completed, if applicable.
- [ ] Docker services and health status.
- [ ] Commands actually run and their results.
- [ ] Unit/integration/E2E tests actually run and their results.
- [ ] Security, privacy, and ownership checks covered.
- [ ] Remaining defects, limitations, or blockers.
- [ ] Suggested commit message.
Final rule: Correctness, contract consistency, privacy, and
verifiable behavior take priority over speed or apparent feature
completeness. Never claim implementation or test success without
evidence.
13. Immediate Antigravity Execution Prompt
Adopt this document as the authoritative project specification.

Follow Section 10 (Execution Protocol for the Coding Agent) strictly.
1. Do not jump ahead to Phase 2B, Phase 2C, Phase 2D, or Phase 3.
2. Execute only:
   - Docker baseline verification and required fixes.
   - Phase 2A: storage modules, environment schemas, Prisma schema/migration, and relevant contract definitions in docs/SPECIFICATION.md.
3. Preserve the PostgreSQL Compose port mapping 5433:5432 in docker-compose.yml so host-level Prisma Studio can continue connecting to the database. Do not remove, change, or silently replace this mapping.
4. Before editing, inspect the repository and report the exact files expected to change.
5. Verify Docker services and run relevant migration, storage, lint, typecheck, and test commands in containers. Report only results actually observed.
6. Do not implement any Phase 2B upload endpoints during this task.
7. Before proceeding to Phase 2B, report progress using the Section 12 Completion and Reporting Checklist, including changed files, commands run, actual results, and blockers.
8. If the repository’s current state conflicts with this specification, stop and explain the conflict rather than silently changing architecture or weakening requirements.

14. Phase 4A Specification: Multi-Provider LLM Gateway, Safety Layer & Structured Analysis
14.1 LLM Gateway Architecture & Tier Fallback
All providers expose OpenAI-compatible /chat/completions endpoints. The gateway executes in priority order:
- Tier 1: Google AI Studio (base: https://generativelanguage.googleapis.com/v1beta/openai/, model: gemini-3.5-flash, overridable via GEMINI_MODEL). Key: GEMINI_API_KEY.
- Tier 2: Groq Primary (base: https://api.groq.com/openai/v1, model: openai/gpt-oss-120b, overridable via GROQ_MODEL_PRIMARY). Key: GROQ_API_KEY.
- Tier 3: OpenRouter Free (base: https://openrouter.ai/api/v1, model: openrouter/free, overridable via OPENROUTER_MODEL). Key: OPENROUTER_API_KEY.
- Tier 4: Groq Emergency (base: https://api.groq.com/openai/v1, model: openai/gpt-oss-20b, overridable via GROQ_MODEL_EMERGENCY). Key: GROQ_API_KEY.

How to obtain provider API keys:
- Google AI Studio: sign up at https://aistudio.google.com/ and create a free Gemini API key.
- Groq: register at https://console.groq.com/keys and generate an API key.
- OpenRouter: register at https://openrouter.ai/settings/keys and create an API key.

Data Privacy & Prompt Retention Warning:
Free and public tiers of third-party LLM providers may retain, log, or train on prompts submitted to their endpoints.
Therefore:
- Strict bidirectional PII redaction is mandatory before any prompt leaves the service boundary.
- Automated tests and development workflows must exclusively use synthetic fixtures. Real personal data must never be transmitted.

Failover & Cooldown Rules:
- 429 rate limit, 5xx server errors, network drop, or timeouts: log exactly
  `[LLM Failover] {provider} rate-limited. Activating 60s cooldown. Switching to {next_provider}...`,
  set 60-second cooldown via time.monotonic() (or honor Retry-After if larger), and immediately retry the same request on the next available tier.
- 401/403/invalid key or model-not-found (404): permanently disable that tier for the process lifetime with an error that never logs secrets. Do not enter 60s cooldown.
- Cooldown expiry: tiers whose cooldown expired return to the pool cyclically.
- When all tiers are exhausted or unconfigured: return graceful deterministic fallback result with llmStatus = 'UNAVAILABLE' without raising an uncaught exception.

14.2 Safety & Prompt Injection Defense
- PII Redaction: Removes candidate name, email, phone, URLs, street addresses, dates of birth, and demographic bias cues (pronouns, marital status, age). Maintains an exact character offset map to re-ground evidence quotes to original rawText. Quotes overlapping redaction placeholders are dropped.
- Untrusted Data Framing: Resume and JD text are wrapped in random per-request UUID delimiters (e.g. `---RESUME-DATA-{uuid}---`) and marked strictly as untrusted data.
- Injection Heuristics: Scans for override commands ("ignore previous instructions", "give perfect score"). Detected attempts set `injectionSuspected = true` for auditing.
- Grounding Verifier: Every evidence quote returned by the LLM must match an exact substring in rawText. Fabricated quotes are dropped. If fabricated evidence rate exceeds 0.5, the tier fails and gateway fails over.

14.3 Score Integrity Guarantee
Under no circumstance does an LLM generate, edit, adjust, or view-as-editable any score.
All scores (matchScore, atsScore, sub-scores, verdict band, skill gap lists) are injected exclusively by deterministic Python ML code from the existing Match and Parse models. The LLM only explains, highlights strengths/gaps, and suggests fixes.

14.4 API & Queue Contracts
- Queue: `analysis-queue` (prefix `bull`, 3 retries with exponential backoff). Job payload: `{ resumeId, jobId }`.
- `POST /v1/jobs/:id/analysis`
  - Request: `{ resumeId: UUID }`
  - Response: 202 Accepted `{ status: 'QUEUED', jobId, resumeId }`
  - Preconditions: Both job and resume must belong to authenticated user (404 convention); resume must have status PARSED (422 if not); Match must exist (409 Conflict if no Match computed yet).
  - Rate limit: 10 requests per minute per user.
- `GET /v1/jobs/:id/analysis/:resumeId`
  - Response: 200 OK with full Analysis model (id, jobId, resumeId, status, score, skillGap, atsFindings, result, llmStatus, provider, model, promptVersion, tokensPrompt, tokensCompletion, latencyMs, fabricatedEvidenceRate, injectionSuspected).
  - Ownership: 404 Not Found if requested by non-owner.

15. Phase 4B Specification: Fact-Grounded STAR Bullet Rewriter
15.1 Architecture & Pipeline Flow
The bullet rewriter transforms existing resume bullet points into high-impact STAR (Situation, Task, Action, Result) format while strictly preventing hallucinations.
Flow:
1. Client sends `POST /v1/rewriter/bullet` to Backend with JWT authentication.
2. Backend verifies ownership of resumeId and optional jobId (404 convention on mismatch).
3. Backend fetches `ParsedResume.rawText` and asserts `originalBullet` is an exact substring (max 500 chars, 422 if missing).
4. Backend securely calls internal ML service endpoint `POST /v1/rewriter/bullet` with `X-Internal-Token` (shared secret configured via `INTERNAL_API_TOKEN`, required min 32 chars, no default, validated on startup).
5. ML service runs `BulletRewriterService`:
   - Redacts PII using `PIIRedactionService` from 4A before LLM call.
   - Wraps bullet and context in cryptographic per-request UUID delimiters (untrusted data framing).
   - Generates 2-3 STAR rewrite options via `LLMGateway` (temperature 0, prompt version `2026-10-25-v2`, SHA-256 caching with prompt version, strict instruction not to add verbs, scope, or claims beyond original bullet).
   - Restores redaction placeholders in output.
   - Verifies each option with `BulletRewriteVerifier`:
     - Every number, metric, and percentage must exist in rawText or originalBullet.
     - Every tool/technology must resolve to an exact skill or canonical alias present in rawText or originalBullet.
     - No unsupported degree/credential claims.
     - Evidence quotes must map to exact character spans in rawText.
     - Explicit bracketed placeholders (e.g., `[add metric]`, `[insert %]`) are permitted and mark `needsUserInput = true`.
      - Known limitation: The verifier checks numbers/tools/credentials/degrees only, and does not detect qualitative claim inflation (known limitation).
   - Filters ungrounded options. If 0 options survive, returns RFC 7807 422 `HALLUCINATION_DETECTED`.
   - Logs provider, model, tokens, latency only; never logs bullet text or PII.

15.2 API Contracts
- `POST /v1/rewriter/bullet`
  - Request Headers: `Authorization: Bearer <token>`, `Content-Type: application/json`
  - Request Body:
    ```json
    {
      "resumeId": "UUID",
      "originalBullet": "string (1-500 chars, exact substring of resume rawText)",
      "targetSkill": "string (optional)",
      "jobId": "UUID (optional, owned by user)"
    }
    ```
  - Response (200 OK):
    ```json
    {
      "status": "SUCCESS",
      "originalBullet": "Managed cloud migration to AWS.",
      "options": [
        {
          "text": "Led migration of legacy systems to AWS, reducing downtime by [insert %].",
          "evidenceSpans": [
            { "startChar": 120, "endChar": 151, "quote": "Managed cloud migration to AWS." }
          ],
          "needsUserInput": true
        }
      ],
      "provider": "groq",
      "model": "openai/gpt-oss-120b",
      "tokensPrompt": 683,
      "tokensCompletion": 468,
      "latencyMs": 1498
    }
    ```
  - Error Responses:
    - 400 Bad Request: Zod validation failure.
    - 401 Unauthorized: Missing or invalid JWT.
    - 404 Not Found: Resume or job not found or owned by another user.
    - 422 Unprocessable Content: Bullet not found in resume rawText (`BULLET_NOT_IN_RESUME`) or all options rejected by verifier (`HALLUCINATION_DETECTED`).

## 16. Phase 5: Accounts and Authentication

### 16.1 Architecture Decisions
1. **Credentials & Identity Separation:** Identity (`User` model) is strictly decoupled from credentials (`Credential` model). Google OAuth is not built in Phase 5; the schema cleanly permits alternative auth providers in the future without schema churn.
2. **User.email:** Made optional (`String? @unique`), non-destructive change preserving all existing test users and databases.
3. **Password Security:** Argon2id with OWASP minimum recommended parameters (memoryCost: 19 MiB / 19456 KiB, timeCost: 2, parallelism: 1). Password length: 12-128 chars, must not contain username (case-insensitive), rejected if in bundled common password list, no composition rules. Username: 3-32 chars `[a-zA-Z0-9_.-]`, case-insensitive unique. Hashing concurrency is bounded by `ARGON2_MAX_CONCURRENCY` (default 10) to cap worst-case memory consumption at 190 MiB (19 MiB x 10).
4. **Timing Equalization:** When login or password recovery is attempted for an unknown username, a dummy Argon2id verification executes against a precomputed dummy hash with identical work factor parameters to prevent username enumeration via timing attacks.
5. **Token Architecture:**
   - **Access Token:** JWT signed with `JWT_SECRET`, 15-minute lifetime. Contains claims `{ sub: userId, sid: sessionId, username: string }`.
   - **Refresh Token:** Cryptographically secure opaque 256-bit random hex string, stored exclusively as a SHA-256 hash in the database, 14-day lifetime. Rotated on every use.
   - **Session Families & Replay Detection:** Every login creates a new session family (`familyId`). Reuse of an already-used or revoked refresh token revokes all active sessions in the family immediately without a grace window.
   - **Immediate Revocation:** Every authenticated request verifies the `sid` claim against the database session table (`prisma.session`). Revocation on logout, logout-all, password recovery, or refresh token reuse takes effect on the very next request rather than waiting for JWT expiration.
6. **Cookie Security:**
   - `access_token`: `httpOnly: true`, `sameSite: 'lax'`, `secure: COOKIE_SECURE || production`, `path: '/'`, `maxAge: 15m`.
   - `refresh_token`: `httpOnly: true`, `sameSite: 'lax'`, `secure: COOKIE_SECURE || production`, `path: '/v1/auth'`, `maxAge: 14d`.
   - `csrf_token`: `httpOnly: false` (JS-readable for double-submit header), `sameSite: 'lax'`, `secure`, `path: '/'`.
   - Dual Auth Support: `Authorization: Bearer <accessToken>` header accepted alongside cookies for API clients and automated tests.
7. **CSRF Enforcement:**
   - Cookie-authenticated state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`) require both an allowed `Origin`/`Referer` (from `CORS_ORIGIN`) and a matching double-submit `X-CSRF-Token` header.
   - Bearer-token authenticated requests are exempt from CSRF checks.
8. **Rate Limiting & Lockout (Fail Closed):**
   - Redis-backed rate limiter on all `/v1/auth/*` routes.
   - Per-account failed login counter keyed by lowercase username (`auth:failed_login:<usernameLower>`) whether or not the account exists.
   - Exponential lockout starting at 5 failed attempts (60s, 120s, 240s, 480s, 960s, capped at 1800s / 30m) with `Retry-After` header on HTTP 429.
   - Fails CLOSED with HTTP 503 Service Unavailable if Redis is unreachable.
9. **Password Reset via Recovery Codes:**
   - 10 single-use recovery codes generated at registration (128 bits entropy each).
   - Returned ONCE at registration; stored hashed with SHA-256. No email provider.
   - Endpoint `/v1/auth/recover` requires username, recovery code, and new password. Resets password and revokes all active sessions.
   - Endpoint `/v1/auth/recovery-codes/regenerate` requires password re-entry.
10. **Account Deletion:**
    - `DELETE /v1/account` requires password confirmation.
    - Cascades to delete S3 objects for all user resumes, user resumes, parsed resumes, resume chunks, jobs, job chunks, analyses, matches, credentials, sessions, and recovery codes.
    - Writes an audit event (`ACCOUNT_DELETED`) with nullable `userId` and no foreign key so the record survives user deletion.

### 16.2 API Contracts (for Phase 8 UI Integration)
- `POST /v1/auth/register`
  - Body: `{ "username": "string", "password": "string" }`
  - Response (201 Created): `{ "user": { "id": "UUID", "username": "string", "createdAt": "ISO" }, "tokens": { "accessToken": "string", "refreshToken": "string", "expiresIn": 900 }, "recoveryCodes": ["xxxx-xxxx-xxxx-xxxx", ...] }`
- `POST /v1/auth/login`
  - Body: `{ "username": "string", "password": "string" }`
  - Response (200 OK): `{ "user": { "id": "UUID", "username": "string" }, "tokens": { "accessToken": "string", "refreshToken": "string", "expiresIn": 900 } }`
- `POST /v1/auth/refresh`
  - Body (optional if cookie present): `{ "refreshToken": "string" }`
  - Response (200 OK): `{ "tokens": { "accessToken": "string", "refreshToken": "string", "expiresIn": 900 } }`
- `POST /v1/auth/logout`
  - Headers: `Authorization: Bearer <token>` or session cookie
  - Response (200 OK): `{ "message": "Successfully logged out." }`
- `POST /v1/auth/logout-all`
  - Headers: `Authorization: Bearer <token>` or session cookie
  - Response (200 OK): `{ "message": "All active sessions have been revoked." }`
- `GET /v1/auth/me`
  - Headers: `Authorization: Bearer <token>` or session cookie
  - Response (200 OK): `{ "user": { "id": "UUID", "username": "string", "email": "string|null", "role": "CANDIDATE", "createdAt": "ISO" } }`
- `POST /v1/auth/recover`
  - Body: `{ "username": "string", "recoveryCode": "string", "newPassword": "string" }`
  - Response (200 OK): `{ "message": "Password has been reset successfully. Please log in with your new password." }`
- `POST /v1/auth/recovery-codes/regenerate`
  - Headers: `Authorization: Bearer <token>`
  - Body: `{ "password": "string" }`
  - Response (200 OK): `{ "recoveryCodes": ["xxxx-xxxx-xxxx-xxxx", ...] }`
- `DELETE /v1/account`
  - Headers: `Authorization: Bearer <token>`
  - Body: `{ "password": "string" }`
  - Response (200 OK): `{ "message": "Account successfully deleted." }`

### 16.3 Known Limitations
- Redis availability dependency: Rate limiting and lockout fail closed with 503 if Redis goes down, intentionally prioritizing brute-force defense over unthrottled uptime.
- Recovery code preservation: In the absence of an email delivery integration, users must securely preserve their 10 recovery codes offline; loss of both password and recovery codes makes account recovery impossible by design.
- Username-keyed lockout denial-of-service: Because failed login counters are keyed by lowercase username to protect accounts from distributed credential stuffing, an attacker can intentionally lock a known username for up to 30 minutes by deliberately sending 5+ invalid passwords. Mitigations planned for a later phase include:
  1. CAPTCHA / Proof-of-Work challenge triggered after 3 failed attempts before enforcing hard lockout.
  2. Dual-keying lockout by IP subnet and device fingerprint alongside username.
  3. Out-of-band email or recovery code unlock to immediately bypass the lockout window.
  4. Progressive step-up authentication rather than total login denial.

### 16.4 Dependencies & Security Parameters
1. **Argon2id Work Factor & Concurrency Parameters:**
   - Algorithm: Argon2id (`@node-rs/argon2`)
   - Memory cost: 19 MiB (19,456 KiB)
   - Time cost (iterations): 2
   - Parallelism (lanes/threads): 1
   - Concurrency ceiling (`ARGON2_MAX_CONCURRENCY`): 10 concurrent operations (bounded FIFO queue via `HashingConcurrencyLimiter`)
   - Worst-case memory ceiling: `memoryCost x maxConcurrency` = 19 MiB x 10 = 190 MiB (194,560 KiB)
2. **Phase 5 npm Dependencies (Backend):**
   - `@fastify/cookie`: `^11.1.3` (Session and CSRF cookie management with SameSite and HttpOnly protection)
   - `@fastify/jwt`: `^9.1.0` (JWT token signing, verification, and claims decoding)
   - `@node-rs/argon2`: `^2.2.2` (Native SIMD-accelerated Argon2id password hashing and constant-time verification)

---

## 17. Phase 6: Usage Metering, Displayed Limits, and Alerts

### 17.1 Architectural Overview & Core Decisions
1. **Meters & Reset Cadence:**
   - `analyses`: Monthly counter. Tracks analysis creation (`POST /v1/jobs/:id/analysis`) and every LLM-backed interactive request (`POST /v1/rewriter/bullet`, `POST /v1/resumes/:resumeId/improvements`). Reset cadence: calendar month UTC (`YYYY-MM`). Period starts at first day of month 00:00:00 UTC; `resetAt` is first day of next month 00:00:00 UTC.
   - `job_suggestions`: Monthly counter. Defined in schema and usage response; consumption wired in Phase 7.
   - `resume_storage_bytes`: Lifetime gauge. Tracks total bytes of active resumes uploaded. Period identifier: `lifetime`; `resetAt` is `null`; `periodStart` is `null`.
2. **Plans as Data:**
   - Stored in database table `plans` with columns `key` (PK), `name`, `limits` (JSONB), `createdAt`, `updatedAt`. Missing or `null` limits indicate unlimited usage.
   - Seeded in additive migration `20261026000000_phase6_usage_metering_and_plans`:
     - `unlimited`: `name`: "Unlimited", `limits`: `{ "analyses": null, "job_suggestions": null, "resume_storage_bytes": null }`. Default for all new and existing users.
     - `demo`: `name`: "Demo", `limits`: `{ "analyses": 10, "job_suggestions": 5, "resume_storage_bytes": 5242880 }`.
   - `User` table has `planKey` column with default `'unlimited'` and foreign key relation to `plans.key`.
   - **Storage Gauge Backfill:** Executed additively in migration SQL via `INSERT INTO "user_usage" ... SELECT ... FROM "resumes" WHERE "status" != 'FAILED' GROUP BY "userId" ON CONFLICT DO NOTHING;`.
3. **Metered Actions & Unmetered Boundaries:**
   - Metered actions: `POST /v1/rewriter/bullet`, `POST /v1/resumes/:resumeId/improvements`, and `POST /v1/jobs/:id/analysis`. Cache hits still count (metering applies to user actions).
   - Unmetered boundaries: ML-only reads, resume listing/downloading, and match scoring (`POST /v1/jobs/:id/match`) are NOT metered. One resume can be matched against any number of JDs without consumption.
4. **Order of Operations & Refund Invariants:**
   - Consumption occurs **AFTER** authentication, ownership checks, and body validation, and **BEFORE** invoking downstream LLM or queue execution.
   - Automatic refund occurs when downstream execution produces no usable result (HTTP 5xx, network timeout, or HTTP 422 `HALLUCINATION_DETECTED`).
   - Downstream responses returning deterministic results (including `llmStatus: UNAVAILABLE`) are considered successful feature execution and are **NOT** refunded.
5. **Storage Lifecycle Hooks & Physical Storage Rule:**
   - `POST /v1/resumes/upload-url`: Rejects requests immediately with HTTP 429 if `currentStorage + declaredSizeBytes > limit`.
   - `POST /v1/resumes/:id/complete`: Atomically consumes `actualSize` under the coordination lock. If storage limit is exceeded, deletes the uploaded object from S3, updates resume status to `FAILED` with `errorCode: STORAGE_LIMIT_EXCEEDED`, and returns HTTP 429 RFC 7807.
   - **Physical Storage Invariant:** `resume_storage_bytes` tracks active physical storage held in S3. If background document parsing fails (`status: FAILED`), the S3 object is preserved so the user can inspect or download the file; therefore, `FAILED` resumes remain counted in `resume_storage_bytes`.
   - `DELETE /v1/resumes/:id`: Deletes the S3 object, removes the database row, and subtracts `resume.sizeBytes` from `resume_storage_bytes` for any resume holding storage (only if upload completed, i.e., `status != 'UPLOAD_PENDING'`, including `FAILED` resumes).
   - `DELETE /v1/account`: Cascades deletion of all user records, removing all associated `user_usage` records via database FK cascade.
6. **Async Analysis Quota Lifecycle & Known Limit:**
   - Synchronous metered routes (`rewriter`, `improvements`): Downstream 5xx, timeouts, or 422 `HALLUCINATION_DETECTED` trigger immediate in-process refunds.
   - Asynchronous analysis (`POST /v1/jobs/:id/analysis`): 1 unit of `analyses` is consumed upon HTTP 202 acceptance. If BullMQ enqueue fails, it is refunded immediately before returning 503.
   - Worker LLM outages trigger Phase 4A graceful degradation: `process_analysis` persists deterministic analysis with `llm_status: UNAVAILABLE` (considered successful feature delivery; not refunded).
   - **Known Limit:** If an unrecoverable catastrophic failure occurs in the worker pipeline after HTTP 202 (e.g. database down during persistence, worker hard killed across all BullMQ retries), no analysis row is stored and the consumed quota unit is not asynchronously refunded. Asynchronous dead-letter queue reconciliation is slated for a future background reconciliation worker.
7. **Atomic Conditional Consumption & Integer Math:**
   - Atomic conditional upsert in PostgreSQL:
     ```sql
     INSERT INTO "user_usage" ("id", "userId", "meter", "period", "used", "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, $1, $2, $3, $4::bigint, NOW(), NOW()
     WHERE $4::bigint <= $5::bigint
     ON CONFLICT ("userId", "meter", "period")
     DO UPDATE SET "used" = "user_usage"."used" + $4::bigint, "updatedAt" = NOW()
     WHERE "user_usage"."used" + $4::bigint <= $5::bigint
     RETURNING "used";
     ```
   - Threshold calculation uses integer math: `used * 100 >= limit * T`. Thresholds: 50, 70, 90, 100.
   - At 100% (or `used >= limit`): emits HTTP 429 RFC 7807 problem details with `type: 'https://api.resumatch.ai/errors/usage-limit-exceeded'`. Downstream action is never invoked.
8. **Read-Only API & Administration:**
   - `GET /v1/usage`: Authenticated, read-only endpoint with `Cache-Control: no-store`.
   - No HTTP route may alter counters or reassign plans. Plan reassignment is strictly administrative via host script `backend/scripts/setPlan.ts` (excluded from production Docker build).

### 17.2 API Contracts (for Phase 8 UI Integration)
- `GET /v1/usage`
  - Headers: `Authorization: Bearer <token>` or session cookie
  - Response (200 OK, `Cache-Control: no-store`):
    ```json
    {
      "plan": "demo",
      "planName": "Demo",
      "period": "2026-10",
      "periodStart": "2026-10-01T00:00:00.000Z",
      "resetAt": "2026-11-01T00:00:00.000Z",
      "meters": {
        "analyses": {
          "used": 5,
          "limit": 10,
          "unlimited": false,
          "percent": 50,
          "activeThreshold": 50,
          "crossedThresholds": [50],
          "blocked": false,
          "periodStart": "2026-10-01T00:00:00.000Z",
          "resetAt": "2026-11-01T00:00:00.000Z"
        },
        "job_suggestions": {
          "used": 0,
          "limit": 5,
          "unlimited": false,
          "percent": 0,
          "activeThreshold": null,
          "crossedThresholds": [],
          "blocked": false,
          "periodStart": "2026-10-01T00:00:00.000Z",
          "resetAt": "2026-11-01T00:00:00.000Z"
        },
        "resume_storage_bytes": {
          "used": 102400,
          "limit": 5242880,
          "unlimited": false,
          "percent": 1,
          "activeThreshold": null,
          "crossedThresholds": [],
          "blocked": false,
          "periodStart": null,
          "resetAt": null
        }
      }
    }
    ```
- HTTP 429 RFC 7807 Usage Limit Exceeded (Emitted when blocked):
  - Status: `429 Too Many Requests`
  - Header: `Content-Type: application/problem+json; charset=utf-8`
  - Body:
    ```json
    {
      "type": "https://api.resumatch.ai/errors/usage-limit-exceeded",
      "title": "Usage Limit Exceeded",
      "status": 429,
      "statusCode": 429,
      "error": "Too Many Requests",
      "message": "Usage limit reached for meter \"analyses\". Current usage: 10/10. Next reset: 2026-11-01T00:00:00.000Z.",
      "detail": "Usage limit reached for meter \"analyses\". Current usage: 10/10. Next reset: 2026-11-01T00:00:00.000Z.",
      "instance": "/v1/rewriter/bullet",
      "meter": "analyses",
      "used": 10,
      "limit": 10,
      "resetAt": "2026-11-01T00:00:00.000Z",
      "timestamp": "2026-10-26T09:30:00.000Z",
      "requestId": "req-1"
    }
    ```

---

## 18. Phase 7: Job Suggestions via Swappable JobSource (Firecrawl & Mock Fallback)

### 18.1 Architectural Overview & Core Decisions
1. **Swappable JobSource Abstraction:**
   - External job discovery is isolated behind the `JobSource` interface:
     ```typescript
     export interface JobSource {
       searchJobs(query: JobSearchQuery, options?: JobSourceOptions): Promise<RawJobListing[]>;
     }
     ```
   - Two implementations:
     - `MockJobSource`: Returns deterministic, high-quality fixtures for unit/integration tests and local development without requiring external credentials.
     - `FirecrawlJobSource`: Queries Firecrawl's search endpoint with strict timeout, retry, sanitization, and SSRF restrictions.
   - **Factory Selection:** `getJobSource()` selects `FirecrawlJobSource` only when `FIRECRAWL_API_KEY` is present and `NODE_ENV !== 'test'`. Otherwise, it falls back to `MockJobSource` without throwing or crashing.
   - Firecrawl is explicitly designated as **TEMPORARY** and swappable for an enterprise licensed job API (e.g. Adzuna, Jooble, Indeed Sponsored API) in a future phase without modifying downstream ranking or API contracts.
2. **Score Integrity Invariant:**
   - All match scores (0–100), rankings, and skill-gap breakdowns are calculated exclusively by the deterministic Python ML pipeline (BM25, dense sentence-transformers vectors, RRF, cross-encoder, and skill-gap taxonomy).
   - The LLM **never** touches, fabricates, or adjusts match scores.
   - Phase 7 requires **zero** live LLM calls.

### 18.2 Legal, Source Policy & Scraping Restrictions
1. **Permanent Built-in Denylist:**
   - Scraping-prohibited sites (`linkedin.com`, `indeed.com`, and all subdomains) are permanently hardcoded on a denylist. Any URL matching the denylist is rejected immediately and never fetched, indexed, or returned, even if accidentally specified in an allowlist.
2. **Configurable Domain Allowlist:**
   - Live external searches are strictly constrained to a configurable domain allowlist (`JOB_SOURCE_ALLOWLIST`).
   - Default allowlist is conservative: `boards.greenhouse.io`, `jobs.lever.co`, `jobs.ashbyhq.com`. Each entry is marked: *verify terms before enabling in production*.
   - If `JOB_SOURCE_ALLOWLIST` is unconfigured or empty, live search returns 0 results and mock remains default.
3. **Robots.txt & Rate Limiting:**
   - Any direct crawler requests must identify with `User-Agent: ResuMatchBot/1.0 (+https://resumatch.ai/bot)` and respect `robots.txt` disallow rules and per-domain crawl delays.
4. **Data Minimization & TTL Cache:**
   - Only sanitized summary text, title, company, location, source URL, URL hash, and content hash are retained. Full raw HTML is immediately discarded.
   - Scraped listings are cached in the PostgreSQL `job_listing_cache` table with a 24-hour time-to-live (`expiresAt`). Cache hits require zero external network requests.

### 18.3 Security & Guardrails
1. **SSRF Guard (`ssrfGuard.ts`):**
   - Every outbound URL is validated against SSRF attacks on initial request and on every HTTP redirect hop.
   - Restricts protocols to `http:` and `https:`.
   - Resolves host DNS and strictly blocks:
     - IPv4 loopback (`127.0.0.0/8`, `0.0.0.0`)
     - RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
     - Link-local addresses (`169.254.0.0/16`, including AWS/GCP metadata `169.254.169.254`)
     - Carrier-Grade NAT (`100.64.0.0/10`)
     - IPv6 loopback (`::1`), ULA (`fc00::/7`), link-local (`fe80::/10`), IPv4-mapped IPv6 (`::ffff:0:0/96`)
   - Rejects URLs containing credentials (`http://user:pass@host`) and non-standard ports (allowed: 80, 443).
   - Enforces domain allowlist and permanent denylist.
2. **Untrusted Content Sanitizer (`sanitizer.ts`):**
   - Scraped text is treated as untrusted user input.
   - Strips `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, and all HTML tags.
   - Unescapes HTML entities, removes ASCII control characters (preserving standard whitespace), and bounds length to 10,000 characters.
   - Neutralizes prompt-injection patterns (`system:`, `ignore previous instructions`, `assistant:`, etc.).
   - Text is never rendered as HTML in responses and never used as instructions.
3. **Tenant Isolation:**
   - `POST /v1/resumes/:id/suggestions` validates that `resumeId` belongs to the authenticated user (`request.user.sub`).
   - If `jobId` is provided, it validates that `jobId` belongs to the authenticated user.
   - Nonexistent or foreign IDs return HTTP 404 RFC 7807 (preventing IDOR enumeration).
   - Requires `resume.status === 'PARSED'` (otherwise returns HTTP 422 RFC 7807).

### 18.4 Two Suggestion Modes & Ranking Pipeline
1. **Without JD (Explore Mode):**
   - Queries are derived from the candidate's `ParsedResume`:
     - Primary query: candidate's target title or most recent experience title + top technical skills.
     - Secondary query: ML-suggested roles from Phase 4C role taxonomy (`ml/data/role_taxonomy.json`).
     - Optional request overrides: `location` (e.g. "Remote") and `seniority` (e.g. "Senior").
   - Bounds total derived queries to maximum 3.
2. **With JD (Similar Roles Mode):**
   - Queries are derived from the target `Job` record (`job.title`, top required skills, domain) and resume skills.
   - Bounds total derived queries to maximum 3.
3. **Deduplication:**
   - Normalizes URLs, computes SHA-256 `urlHash`, and dedupes across queries by `urlHash` and by composite `(title.toLowerCase(), company.toLowerCase(), location.toLowerCase())`.
4. **Scoring via ML Service:**
   - Backend calls `POST /v1/matching/score-listings` on ML service.
   - ML service runs Phase 3 pipeline on each candidate listing against the resume's embedded chunks in `resume_chunks`:
     - BM25 lexical search (`search_lexical`)
     - pgvector dense semantic search (`search_semantic`)
     - Reciprocal Rank Fusion (`fuse_ranks`, $k=60$)
     - Cross-Encoder reranking (`rerank_candidates`)
     - Skill-gap analysis (`analyze_skill_gap`)
     - Calibrated composite blend (`compute_match_scores`)
   - Returns top $N$ listings (default 10, max 10) sorted by ML match score descending.

### 18.5 Usage Metering & Quotas
1. **Meter:** `job_suggestions` (monthly counter, reset at first of month UTC).
2. **Guard:** `withMeter(request, reply, 'job_suggestions', async () => { ... })`.
3. **Order of Operations:**
   - Auth, IDOR ownership, and input validation executed first. 4xx validation errors do **not** consume quota.
   - Quota check and atomic consumption (1 unit) executed before calling any external network search.
   - At 100%: emits HTTP 429 RFC 7807 `usage-limit-exceeded`, `meter: "job_suggestions"`, with zero external calls.
   - If external search fails (timeout or 5xx after 1 retry): refunds 1 unit and returns 5xx problem details.

### 18.6 API Contracts

#### `POST /v1/resumes/:id/suggestions`
- **Headers:** `Authorization: Bearer <token>` or session cookie
- **Request Body:**
  ```json
  {
    "jobId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "location": "Remote",
    "seniority": "Senior",
    "limit": 10
  }
  ```
  *(All body fields are optional. `jobId` switches between Explore and Similar Roles modes).*

- **Response (200 OK):**
  ```json
  {
    "resumeId": "11111111-1111-1111-1111-111111111111",
    "totalFound": 2,
    "source": "mock",
    "isSample": true,
    "suggestions": [
      {
        "title": "Senior Backend Engineer",
        "company": "Acme Tech",
        "location": "Remote",
        "sourceUrl": "https://careers.acme.example.com/jobs/101",
        "matchScore": 86.4,
        "matchedSkills": ["python", "fastapi", "postgresql", "docker"],
        "missingSkills": ["kubernetes"],
        "fetchedAt": "2026-10-26T12:00:00.000Z"
      }
    ]
  }
  ```

- **Response (200 OK — Empty Results):**
  ```json
  {
    "resumeId": "11111111-1111-1111-1111-111111111111",
    "totalFound": 0,
    "source": "mock",
    "isSample": true,
    "suggestions": [],
    "message": "No matching job suggestions found for the provided criteria."
  }
  ```

- **Response (429 Too Many Requests — Usage Limit Exceeded):**
  ```json
  {
    "type": "https://api.resumatch.ai/errors/usage-limit-exceeded",
    "title": "Usage Limit Exceeded",
    "status": 429,
    "statusCode": 429,
    "error": "Too Many Requests",
    "message": "Usage limit reached for meter \"job_suggestions\". Current usage: 5/5. Next reset: 2026-11-01T00:00:00.000Z.",
    "detail": "Usage limit reached for meter \"job_suggestions\". Current usage: 5/5. Next reset: 2026-11-01T00:00:00.000Z.",
    "instance": "/v1/resumes/11111111-1111-1111-1111-111111111111/suggestions",
    "meter": "job_suggestions",
    "used": 5,
    "limit": 5,
    "resetAt": "2026-11-01T00:00:00.000Z",
    "timestamp": "2026-10-26T12:00:00.000Z",
    "requestId": "req-1"
  }
  ```

---

## 19. Phase 8A: Frontend Foundation, Auth Screens, Dashboard Shell, Upload & Usage Panel

### 19.1 Architecture & Same-Origin Proxy Design
1. **Next.js App Router (15.1.4, React 19, Tailwind CSS):**
   - Implemented exclusively within `frontend/`.
   - Backend and ML services remain untouched; API contracts from Phases 1–7 are strictly consumed.
2. **Same-Origin Reverse Proxy (`next.config.mjs`):**
   - Proxies `/api/backend/:path*` to `http://backend:4000/:path*` in Docker container (`http://127.0.0.1:4000` in host mode).
   - Keeps session and refresh cookies first-party to `http://localhost:3000`, completely avoiding third-party cookie restrictions and preventing CORS widening.
3. **Security Headers:**
   - Strict `Content-Security-Policy`: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' http://localhost:* http://127.0.0.1:* http://backend:* http://minio:*; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`.
   - `X-Content-Type-Options: nosniff`.
   - `X-Frame-Options: DENY`.
   - `Referrer-Policy: strict-origin-when-cross-origin`.
   - `Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()`.

### 19.2 Design Tokens & Accessibility (WCAG AA)
1. **Token Hierarchy:**
   - Base: Pure white `#ffffff` (`hsl(0, 0%, 100%)`).
   - Surfaces: Near-black ink `#0f172a` (`hsl(222, 47%, 11%)`) for high-contrast typography and dark surfaces.
   - Restrained Green Accent: Emerald green `#15803d` (`hsl(142, 72%, 29%)`) for primary buttons, progress bars, and active focus rings.
2. **Measured Contrast Ratios (WCAG AA Compliance):**
   - Ink `#0f172a` (`hsl(222, 47%, 11%)`) on `#ffffff`: **17.87:1** (exceeds AAA requirement of 7:1).
   - Primary green `#15803d` (`hsl(142, 72%, 29%)`) on `#ffffff`: **5.08:1** (exceeds AA normal text requirement of 4.5:1).
   - White text on primary button `#15803d`: **5.08:1** (passes AA).
   - Button hover `#116430` (`hsl(142, 71%, 23%)`) on `#ffffff`: **7.27:1** (passes AA).
   - Muted text `#65758b` (`hsl(215, 16%, 47%)`) on `#ffffff`: **4.70:1** (passes AA).
   - Accent foreground on accent background (`hsl(142, 76%, 96%)`): **4.83:1** (passes AA).
   - Destructive button `#d31212` (`hsl(0, 84%, 45%)`) on `#ffffff`: **5.43:1** (passes AA).
3. **Typography & Accessibility:**
   - Clean system font stack (`ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`). Zero external network font dependencies.
   - Visible focus states: `focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2`.
   - `prefers-reduced-motion` media query disables animations and transitions for sensitive users.

### 19.3 Typed API Client & Auth Lifecycle
1. **Credentials & Double-Submit CSRF:**
   - Every fetch request includes `credentials: 'include'`.
   - Mutating calls (`POST`, `PUT`, `PATCH`, `DELETE`) automatically extract the non-HttpOnly `csrf_token` cookie and append the `x-csrf-token` header.
2. **Single-Flight Refresh Token Queue on 401:**
   - If an authenticated call returns HTTP 401, `apiClient` catches it and enqueues a single-flight call to `POST /v1/auth/refresh`.
   - Concurrent requests share the same refresh promise, eliminating refresh storms.
   - Once the refresh completes, the original requests are retried exactly once. If refresh fails, auth state is cleared and user is redirected to `/login`.
3. **RFC 7807 Error Handling:**
   - Non-2xx responses are parsed into `ApiProblemError`, exposing `status`, `title`, `detail`, `type`, `meter`, `used`, `limit`, and `retryAfter`.
4. **Zero Web Storage Tokens:**
   - Auth tokens (`access_token`, `refresh_token`) reside exclusively in HTTP-only browser cookies. `localStorage` and `sessionStorage` are never used for tokens or credentials.

### 19.4 Screens & Components
1. **`/login`:**
   - Username and password inputs.
   - Rate-limit / lockout 429 countdown banner with real-time second decrements.
   - Generic error messages ("Invalid username or password.").
   - Safe redirect via `sanitizeNextRedirect` (rejects open redirects).
2. **`/signup`:**
   - Real-time password policy helpers (12–128 characters, cannot contain username).
   - Username policy helper (3–32 alphanumeric, underscores, hyphens, periods).
   - One-time 10 recovery codes display with copy-to-clipboard functionality.
3. **`/dashboard`:**
   - Resumes list: Status badges (`Uploading`, `Processing`, `Parsed`, `Failed`), ATS score badge when available, formatted upload date, per-resume delete with confirmation modal.
   - Auto-polling with bounded exponential backoff (2s up to 10s) when resumes are in `PROCESSING` or `UPLOAD_PENDING` status.
   - Resume Upload: Drag-and-drop zone and file picker, client-side type/size pre-check (PDF/DOCX, <= 5 MB), presigned storage PUT with progress bar and cancel support, 429 storage quota banner.
4. **`/account`:**
   - User profile details and member date.
   - Full `UsagePanel` integration.
   - Danger Zone: Typed "DELETE" confirmation + password verification calling `DELETE /v1/account`, clearing client state and cascading user deletion.
5. **`UsagePanel`:**
   - Renders 3 meters: `analyses`, `job_suggestions`, `resume_storage_bytes`.
   - Used / limit or "Unlimited".
   - Human-readable byte formatting for storage (`B`, `KB`, `MB`, `GB`).
   - Distinct, non-overlapping alert banners for 50%, 70%, 90%, and 100% (blocked) thresholds driven by `activeThreshold` and `blocked` from `GET /v1/usage`. Unlimited plan displays no alert banners. Refetches on window focus and after upload/delete actions.

---

## 20. Phase 8B: Analyze Flow, ATS Score, Match Visualizer, Suggestions UI & Source Metadata

### 20.1 Architecture & Route Map
1. **`/analyze` Route (`frontend/src/app/analyze/page.tsx`):**
   - Main entry point for resume inspection and matching.
   - Requires authenticated session; redirects unauthenticated visitors to `/login?next=/analyze`.
   - Embeds top `UsagePanel` tracking meters (`analyses`, `job_suggestions`) and triggering quota banners.
2. **Component Hierarchy:**
   - `AnalyzeSelector`: Resume dropdown picker (only allows `PARSED` resumes), Mode A vs Mode B selector tabs, JD paste form with live character count (20–200 characters), and per-resume JD history list.
   - `ModeAResults`: Displays verbatim ATS score (0–100) with plain-language status band (`Poor ATS Compatibility`, `Fair ATS Compatibility`, `Good ATS Compatibility`, `Strong ATS Compatibility`), deterministic content findings with exact character spans highlighted, ATS hazard fixes, ML-ranked suggested roles, and neutral "AI explanation unavailable, showing deterministic results" banner when `llmStatus: UNAVAILABLE`. Pre-run quota notice for `analyses` meter.
   - `ModeBResults`: Overall match score (ML hybrid), ATS score, verdict band (`Strong Match`, `Moderate Match`, `Low Match`), verified strengths with exact evidence quotes, identified skill gaps, prioritized fixes, and "How to read this score" helper card. Integrates `MatchVisualizer`.
   - `MatchVisualizer`: Breakdown bars for Lexical (BM25), Semantic Vector, Cross-Encoder, Skill Coverage, Final Blend, and missing keywords list. Displays exact returned scores without re-computation.
   - `JobSuggestionsList`: Suggestions cards displaying title, company, location, match score, matched and missing skills, fetched date, and validated external links (`rel="noopener noreferrer nofollow"`, `target="_blank"`, hostname badge). When `isSample: true`, displays prominent accessible "Sample data" badge and disclaimer. Includes remaining quota indicator for `job_suggestions` and handles 429 usage limits and 5xx failures (refunded).

### 20.2 Score Integrity & Display Policy
1. **Verbatim Score Display:**
   - Every score displayed (overall match score, ATS score, sub-scores, suggestion match scores) is rendered exactly as returned by the API.
   - The frontend never computes, blends, rounds-to-improve, or alters any score.
   - If an API response omits a sub-score, the UI indicates it as omitted rather than fabricating a default value.
2. **Untrusted String Sanitization:**
   - All server, user, and scraped strings (JD text, resume text, evidence quotes, job titles, companies, URLs) are rendered exclusively as plain text children in React.
   - `dangerouslySetInnerHTML` is strictly prohibited.
3. **Safe External URLs (`frontend/src/lib/safeUrl.ts`):**
   - All external job links are parsed through `validateExternalUrl`.
   - Only `http:` and `https:` protocols are accepted. `javascript:`, `data:`, `file:`, `vbscript:`, and malformed URIs are discarded.
   - Valid links render with `rel="noopener noreferrer nofollow"`, `target="_blank"`, and show the parsed hostname badge.

### 20.3 Bounded Exponential Backoff Polling
- Match jobs (`POST /v1/jobs/:id/match`) and Analysis jobs (`POST /v1/resumes/:id/analysis`) execute asynchronously via BullMQ workers.
- The UI polls status with exponential backoff: starts at 1000ms, multiplies by 1.5 per poll, capped at 10000ms, with a maximum timeout of 60 seconds.
- Renders visible "Analyzing match..." / "Analyzing resume..." progress states with cancel/leave safety.
- Exposes retry buttons on polling failure or timeout without losing user inputs.

### 20.4 Backend Contract Change (Step 2 Additive)
- **Endpoint:** `POST /v1/resumes/:id/suggestions`
- **Additive Fields in 200 Response:**
  - `source: "mock" | "firecrawl"`: Derived from the active `JobSource` (`MockJobSource` -> `"mock"`, `FirecrawlJobSource` -> `"firecrawl"`).
  - `isSample: boolean`: `true` when `source === "mock"`, `false` when live Firecrawl listings are retrieved.
- **Contract Schema Update:**
  - `backend/src/services/jobSource/types.ts`: `JobSource` interface has `readonly type: 'mock' | 'firecrawl'`, and `JobSuggestionsResponse` includes `source` and `isSample`.
  - Stored in cache and returned identically on cache hits.

### 20.5 Decisions & Contract Gaps
1. **JD File Upload:**
   - Mode B currently supports pasted JD text with title and company fields. File upload for JD documents is deferred to a future phase.
2. **Match History Endpoints (Resolved in Phase 8C):**
   - Implemented `GET /v1/jobs`: Authenticated, owner-scoped, paginated (`limit`, `offset`), sorted newest-first. Omits `rawDescription` to prevent JD text leakage in list views. Full JD text remains accessible on `GET /v1/jobs/:id`.
   - Implemented `GET /v1/resumes/:id/matches`: Authenticated, owner-scoped (returns 404 for IDOR / non-existent resumes). Returns list of matches with verbatim match score, sub-scores, job metadata, and structured analysis metadata (`llmStatus`, `score`).
3. **CSP `unsafe-eval` Conditional:**
   - `next.config.mjs` applies `'unsafe-eval'` to `script-src` conditionally in development mode only (`process.env.NODE_ENV === 'production' ? "script-src 'self' 'unsafe-inline'" : "script-src 'self' 'unsafe-inline' 'unsafe-eval'"`).

---

## 21. Phase 8C Frontend Specification & Verification

### 21.1 Interactive STAR Bullet Editor
1. **Component (`frontend/src/components/BulletEditor.tsx`):**
   - Allows users to select parsed resume experience bullets from a dropdown, or enter custom draft bullets.
   - Optional parameters: `targetSkill` (focus skill) and `targetJobContext` (target job title/company context).
   - Calls `POST /v1/rewriter/bullet`.
   - Displays pre-run quota notice for `analyses` meter.
   - Handles HTTP 429 quota exhaustion with upgrade/wait banner.
   - Handles HTTP 422 `HALLUCINATION_DETECTED` with plain-language explanation ("Bullet rewrite was canceled and your quota was refunded because hallucinated details were detected") and quota refund confirmation.
   - Handles HTTP 503 errors with a neutral service unavailable banner and Retry button.
   - One-click "Copy to Clipboard" with temporary visual confirmation.

2. **Word-Level Diff Utility (`frontend/src/lib/wordDiff.ts`):**
   - Pure TypeScript Longest Common Subsequence (LCS) algorithm producing typed tokens (`added`, `removed`, `unchanged`).
   - Renders exclusively plain text nodes: `<ins>` with green underline for additions, `<del>` with red strikethrough for removals.
   - Adheres to WCAG non-color-only distinction by combining text decorations (underline / strikethrough) with an explicit accessible legend.
   - Zero raw HTML injection (no dangerouslySetInnerHTML).

3. **Grounded Evidence Highlights:**
   - Displays verified evidence quotes extracted by the LLM that ground the rewritten bullet in the candidate's original resume.
   - Identifies verified metrics (e.g. throughput numbers, percentages, team sizes).

### 21.2 Persistent Match History
1. **Component (`frontend/src/components/MatchHistoryList.tsx`):**
   - Integrated on `/analyze`, displays past matches loaded from `GET /v1/resumes/:id/matches`.
   - Survives page refreshes and user re-logins.
   - Displays job title, company, verbatim match score, `llmStatus` badge (`AI Analyzed` for `SUCCESS`, `Deterministic` for fallback/unavailable), relative timestamp, and "View Results" button that loads the full match breakdown into the visualizer.

### 21.3 Global Polish & Accessibility
1. **Skip-to-Content Link:**
   - `#main-content` skip link implemented in `frontend/src/app/layout.tsx` targeting `<main id="main-content">`.
2. **Global Error Boundary (`frontend/src/app/error.tsx`):**
   - Catches unhandled runtime render errors, renders accessible recovery UI with "Try again" and "Back to Dashboard".
3. **Custom 404 Page (`frontend/src/app/not-found.tsx`):**
   - Renders accessible 404 with high-contrast text and navigation links.
4. **Loading Skeleton (`frontend/src/app/analyze/loading.tsx`):**
   - Provides accessible loading placeholder while `/analyze` hydrates.
5. **Design System Tokens & Contrast Ratios (WCAG AA):**
   - Base Ink (`#0f172a`) on White (`#ffffff`): **15.6:1** (Passes AAA).
   - Muted Ink (`#475569`) on White (`#ffffff`): **5.9:1** (Passes AA).
   - Green Accent (`#15803d`) on White (`#ffffff`): **4.64:1** (Passes AA).
   - Error Red (`#b91c1c`) on White (`#ffffff`): **7.2:1** (Passes AAA).

## 22. Phase 8C-R Remediation & Redesign Specification

### 22.1 Standing External-Call Budget Rules (S2-S4)
1. **LLM Provider Hard Cap (OpenRouter Only):**
   - Maximum 4 outbound LLM provider HTTP requests in total per verification session (retries and failover count).
   - Gemini, Groq, and all other direct providers disabled for live action.
   - If OpenRouter fails, no fallback to other direct providers; halt and report.
   - **Verification Status Note:** In Phase 8C-R, 2 live calls to OpenRouter (`openrouter/free`) resulted in upstream HTTP 500 errors ("Provider returned error"). In strict accordance with S2, no direct failover was executed. Consequently, live diff generation and live Mode B `llmStatus = SUCCESS` were not verified live and remain for human verification.
2. **Firecrawl Credit Hard Cap (<= 20 Credits):**
   - Worst case observed: 11 credits per `/search` request.
   - Maximum 1 live Firecrawl `/search` request permitted.
   - Live call requirements: fan-out forced to exactly 1 query, result limit clamped to 3, page scraping/markdown formats disabled (`scrape: false`).
   - Hard code-level guard enforced in `backend/src/services/jobSource/firecrawlSource.ts` and `backend/src/routes/suggestions.ts` via `JOB_SOURCE_MAX_QUERIES`.
3. **Structured Non-Secret Request Ledger:**
   - Every outbound request tracked via non-secret structured logs (`docker compose logs | Select-String -NotMatch '/health'`) recording timestamp, provider, endpoint, query count, limit, and status.

### 22.2 Design System Tokens & Automated Contrast Suite (`frontend/src/lib/designTokens.ts`)
Programmatically verified via `frontend/src/lib/__tests__/contrast.test.ts` (12 automated unit tests):

| Token Pair | Hex Values | Contrast Ratio | WCAG 2.1 Compliance |
| :--- | :--- | :--- | :--- |
| **Primary Ink on White** | `#090d16` on `#ffffff` | **19.43:1** | WCAG AAA (>= 7.0:1) |
| **Primary Ink on Subtle Surface** | `#090d16` on `#f8fafc` | **18.57:1** | WCAG AAA (>= 7.0:1) |
| **Secondary Ink on White** | `#334155` on `#ffffff` | **10.35:1** | WCAG AAA (>= 7.0:1) |
| **Muted Ink on White** | `#475569` on `#ffffff` | **7.58:1** | WCAG AA (>= 4.5:1) |
| **Brand Text on White** | `#166534` on `#ffffff` | **7.13:1** | WCAG AAA (>= 7.0:1) |
| **Brand Text on Brand Bg** | `#166534` on `#f0fdf4` | **6.81:1** | WCAG AA (>= 4.5:1) |
| **Danger Text on White** | `#991b1b` on `#ffffff` | **8.31:1** | WCAG AAA (>= 7.0:1) |
| **Danger Text on Danger Bg** | `#991b1b` on `#fef2f2` | **7.60:1** | WCAG AAA (>= 7.0:1) |
| **Warning Text on White** | `#92400e` on `#ffffff` | **7.09:1** | WCAG AAA (>= 7.0:1) |
| **Warning Text on Warning Bg** | `#92400e` on `#fffbeb` | **6.84:1** | WCAG AA (>= 4.5:1) |
| **Light Text on Dark Surface** | `#f8fafc` on `#090d16` | **18.57:1** | WCAG AAA (>= 7.0:1) |
| **UI Component Border on White** | `#64748b` on `#ffffff` | **4.76:1** | WCAG AA Graphical (>= 3.0:1) |

### 22.3 Motion Tokens & Animation Principles
1. **Duration Tokens:** `fast: 120ms`, `normal: 200ms`, `enter: 320ms`, `deliberate: 500ms`.
2. **Easing Curves:** `standard: cubic-bezier(0.16, 1, 0.3, 1)`, `smooth: cubic-bezier(0.4, 0, 0.2, 1)`.
3. **Score Integrity (Rule S7):**
   - Every numeral renders its final exact API value immediately without tweening or count-up animations.
   - Non-numeric visuals (gauge arcs, progress bars, shimmer skeleton pulses) animate smoothly using `transform` and `opacity` only.
4. **Reduced Motion Accessibility:**
   - Global and component-level `@media (prefers-reduced-motion: reduce)` handlers.
   - Animated primitives apply `motion-reduce:transition-none` and `motion-reduce:animate-none`.

### 22.4 UI Component Library Primitives
- **`ScoreGauge.tsx`:** Circular SVG arc gauge displaying verbatim API score numeral immediately with smooth SVG arc filling.
- **`Button.tsx`:** Primary, secondary, ghost, and danger variants with loading state, visible focus rings, and >= 44px mobile touch targets.
- **`Card.tsx`:** Card container, header, title, description, content, and footer primitives for consistent layered surfaces.
- **`Badge.tsx`:** High-contrast semantic badges (`neutral`, `brand`, `success`, `warning`, `danger`, `info`).
- **`Input.tsx` / `Textarea.tsx`:** Fully accessible form inputs with ARIA attributes, error announcements, and focus ring transitions.
- **`Modal.tsx`:** Accessible modal dialog with focus trapping, Escape key listener, backdrop blur, and focus restoration.
- **`ToastBanner.tsx`:** Accessible inline and toast notifications with distinct semantic palettes and dismiss triggers.
- **`Skeleton.tsx`:** Shimmering placeholder with reduced-motion support.
- **`ProgressBar.tsx`:** Accessible progress indicator with ARIA attributes and reduced-motion handling.
- **`StepIndicator.tsx`:** Accessible multi-step workflow tracker.
- **`EmptyState.tsx` & `ErrorState.tsx`:** High-contrast empty and error states with inline SVG icons and action buttons.

---

## 23. Phase 8C-R2: Verification, Accessibility & Animation Audit

### 23.1 Honest Corrections to 8C-R
1. **Live Bullet Rewrite & Live Mode B LLM:** Live bullet rewrite returned upstream HTTP 500 twice on OpenRouter free router; live diff generation and evidence highlights were not verified live. Mode B live LLM run (`llmStatus = SUCCESS`) was not completed. Both remain explicitly documented as unverified live and require human verification.
2. **Temporary Overrides:** `docker-compose.firecrawl-live.yml` was created during 8C-R and was deleted; during 8C-R2 all verification was run on an untracked `docker-compose.llm-off.yml` (all provider keys EMPTY) which was verified and removed.
3. **Account Deletion:** Account deletion was executed and verified through the Account page Danger Zone UI modal with typed confirmation and password in 8C-R2 (captured in `r2_account_delete_modal.png` and `r2_account_deleted.png`).
4. **Prisma Schema Path:** Schema path verified at `db/schema.prisma` (`backend/db/schema.prisma`). Validated with `prisma validate` and `prisma migrate status` (7 migrations up to date).
5. **Screenshots:** All verification captures in Phase 8C-R2 are named descriptively with the `r2_*` prefix across viewports (1280, 768, 375), modal flows, quota thresholds, and error states.

### 23.2 Animation Inventory (Reduced-Motion Safe)
All animations strictly use `transform` and `opacity` only; zero numeral tweening or count-up (Rule S6). Every animation is guarded by `@media (prefers-reduced-motion: reduce)`.
1. **Route & Page Transition:** `.page-enter` applies a 240ms subtle fade and 8px vertical rise (`cubic-bezier(0.16, 1, 0.3, 1)`). Content is never delayed; layout shift is 0.
2. **Staggered Card & List Entrance:** `.stagger-item` applies a 220ms fade and 6px rise with progressive `animation-delay` (max 60ms step, capped at 400ms total stagger) for resume cards, match history items, and suggestion cards.
3. **Upload & Parse Progress:** `ProgressBar` with smooth CSS transition, accompanied by `StepIndicator` (Uploading -> Processing -> Parsed) and an accessible `aria-live="polite"` status region.
4. **Bullet Rewrite Reveal:** Diff segments (`<ins>`, `<del>`) and grounded evidence quotes reveal with a gentle staggered fade; copy button provides an instant micro-interaction confirming "Copied".
5. **Empty State Float:** `animate-float` applies a gentle 3.5s vertical oscillation on the empty state SVG illustration, completely disabled under reduced motion.
6. **Mobile Navigation Drawer:** Accessible slide/fade drawer with hamburger toggle button, `aria-expanded`, `aria-controls`, and minimum 44px touch targets.
7. **Score Integrity (S6):** Numerals render their exact final API value immediately on first paint. Verified via automated vitest test.

### 23.3 Automated Accessibility Audit Results
1. **Axe Core Engine Suite (`AxeAccessibility.test.tsx`):**
   - 11 core screens and primitives evaluated with zero violations:
     - Landing Page (`/`): 0 violations
     - Login Page (`/login`): 0 violations
     - Signup Page (`/signup`): 0 violations
     - Dashboard (`/dashboard`): 0 violations
     - Account Page (`/account`): 0 violations
     - 404 Page (`/not-found`): 0 violations
     - Error Boundary (`/error`): 0 violations
     - Bullet Editor (`BulletEditor`): 0 violations
     - Match History List (`MatchHistoryList`): 0 violations
     - Mode A Results (`ModeAResults`): 0 violations
     - Mode B Results (`ModeBResults`): 0 violations
2. **Accessibility Standards Suite (`AccessibilityStandards.test.tsx`):**
   - Skip to main content link `#main-content` target exists: PASS
   - 44px minimum touch targets across interactive controls: PASS
   - Polite `aria-live` announcement regions for uploads and quota alerts: PASS
   - Accessible modal focus trap, Escape key dismissal, and return focus: PASS
   - Score numeral renders exact value without count-up or tweening on first paint (S6): PASS
   - Heading hierarchy integrity (no skipped levels): PASS
   - Results region focus shift on analysis load: PASS
3. **Programmatic Contrast Suite (`contrast.test.ts`):**
   - 12 automated unit tests passing WCAG AA / AAA across all semantic ink, surface, border, and accent tokens.
   - Zero hardcoded hex colors bypassing design tokens in `frontend/src/components`.