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