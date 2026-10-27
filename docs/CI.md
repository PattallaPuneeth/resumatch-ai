# ResuMatch AI — Continuous Integration & Quality Gates Specification

## 1. Overview & Core Philosophy

ResuMatch AI enforces strict quality, security, and reliability gates on all pull requests and branch pushes. CI is engineered to:
1. **Prevent Regressions:** Automatically catch type mismatches, broken tests, security vulnerabilities, Dockerfile anti-patterns, workflow syntax errors, and ranking accuracy regressions before code merges.
2. **Strict Isolation:** Run all integration tests against isolated ephemeral containers (`docker-compose.ci.yml` / GitHub Actions service containers) on non-conflicting ports, guaranteeing **zero modification** to local development databases.
3. **Zero Secrets in CI:** External LLM (OpenRouter/Gemini/Groq) and web crawler (Firecrawl) keys are disabled (`EMPTY`) in CI. All evaluations and integration tests execute deterministically using local embedding models, deterministic scoring pipelines, mock job sources, and synthetic fixtures.
4. **Local Parity:** Any CI failure can be reproduced locally with byte-for-byte fidelity using `./scripts/ci-local.ps1` (PowerShell) or `./scripts/ci-local.sh` (Bash).

---

## 2. GitHub Actions Workflow Matrix (`.github/workflows/ci.yml`)

The CI workflow triggers on pushes to `main`, `master`, and `queue/**`, as well as all pull requests targeting `main` or `master`. It declares top-level `permissions: contents: read`, `concurrency: cancel-in-progress: true`, and bounded per-job timeouts (`timeout-minutes: 10` for unit/lint jobs, `15` for end-to-end smoke).

| Job Name | Runner / Environment | Key Verification Steps | Pass / Fail Criteria |
| :--- | :--- | :--- | :--- |
| **`lint`** | `ubuntu-latest` | `rhysd/actionlint:1.7.7`<br>`hadolint/hadolint:v2.12.0` | Zero GitHub Actions workflow syntax errors. Zero Dockerfile lint errors across all 3 Dockerfiles using `.hadolint.yaml`. |
| **`backend-ci`** | `ubuntu-latest`<br>Node 22, PG 16, Redis 7 | `npm ci`<br>`prisma validate`<br>`prisma migrate deploy`<br>`prisma migrate status`<br>`npm run build`<br>`npm test` | All 426+ Vitest tests must pass. Prisma migrations must deploy cleanly on empty DB with zero drift. TypeScript compilation must succeed with 0 errors. |
| **`frontend-ci`** | `ubuntu-latest`<br>Node 22 | `npm ci`<br>`npm run lint`<br>`npm run typecheck`<br>`npm test`<br>`npm run build` | Zero ESLint errors. Next.js 15 typecheck must pass. All 129 Vitest tests pass. Next.js standalone production build must succeed. |
| **`ml-ci`** | `ubuntu-latest`<br>Python 3.11, Tesseract OCR | `pip install`<br>`pip-audit`<br>`ruff check ml`<br>`mypy ml`<br>`pytest ml/tests -m "not live"` | Zero Ruff lint violations. Zero Mypy typecheck errors. All 224+ Pytest unit & integration tests pass. |
| **`ml-eval-gate`** | `ubuntu-latest`<br>Python 3.11 (Needs `ml-ci`) | `python -m ml.eval.gate` | Pairwise ordering accuracy >= 83.00%. Strong candidate mean >= 60.0. Weak candidate mean <= 45.0. Label separation gap >= 20.0 pts. Zero run-to-run variance across deterministic fixtures. |
| **`security-ci`** | `ubuntu-latest` | `gitleaks-action@f586c14365d4643c6aa59d472ae6e984bf47bb34`<br>`trivy-action@18f2510ee396bbf400402947b394f2dd8c87dbb0` | Scans repository history for secrets (with redaction). Scans filesystem for fixable HIGH/CRITICAL vulnerabilities. |
| **`e2e`** | `ubuntu-latest`<br>Full Docker Compose Stack | `docker compose up -d --wait`<br>`node e2e/smoke.mjs`<br>`docker compose down` | Runs complete 11-step E2E API smoke suite through frontend proxy against mock stack: registration, synthetic upload, parsing, Mode A JD, match scoring, match history, suggestions, idempotency replay, and account cascade deletion. |

---

## 3. Required GitHub Branch Protection Settings

To ensure zero unverified code merges into `main` / `master`, the repository owner must configure the following Branch Protection Rules in GitHub (`Settings -> Branches -> Add branch ruleset / protection rule`):

### Target Branch: `main` (and `master`)
1. **Require a pull request before merging**:
   - Require approvals: `1`
   - Dismiss stale pull request approvals when new commits are pushed: `Enabled`
2. **Require status checks to pass before merging**:
   - Require branches to be up to date before merging: `Enabled`
   - **Required Status Checks (exact context names):**
     - `Code & Container Linting (Actionlint / Hadolint)`
     - `Backend CI (Fastify / TypeScript / Node 22)`
     - `Frontend CI (Next.js 15 / React / TypeScript)`
     - `ML Service CI (Python 3.11 / FastAPI / PyTorch)`
     - `ML Eval Quality Gate (Ranking Accuracy & Calibration)`
     - `Security Quality Gate (Gitleaks & Trivy)`
     - `End-to-End API Smoke Gate`
3. **Require linear history**: `Enabled` (prevents merge commits, keeps bisect clean)
4. **Do not allow bypassing the above settings**: `Enabled` (applies to administrators as well)

---

## 4. Local Reproduction & Parity Commands

Every CI stage can be executed locally with byte-for-byte parity:

### 1. Workflow & Container Linting
```powershell
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.7
docker run --rm -v "${PWD}:/repo" -w /repo hadolint/hadolint:v2.12.0 hadolint -c /repo/.hadolint.yaml backend/Dockerfile frontend/Dockerfile ml/Dockerfile
```

### 2. Isolated Full Stack CI Run
```powershell
.\scripts\ci-local.ps1
```
Spawns ephemeral services on `55432`, `56379`, `59000` with `tmpfs` RAM-disks, executes full backend vitest suite, verifies migration deploy on empty DB, and destroys containers cleanly on exit.

### 3. End-to-End API Smoke Gate
```powershell
node e2e/smoke.mjs
```
Runs the 11-step API smoke suite against the running local stack through `http://localhost:3000/api/backend`.

### 4. ML Evaluation Quality Gate
```powershell
docker compose exec ml python -m ml.eval.gate --fixture-dir ml/eval/ci_fixtures --baseline ml/eval/ci_fixtures/baseline.json
```

---

## 5. Security & Secret Protection Standard

1. **SHA Pinning:** All third-party GitHub Actions are pinned to full immutable commit SHAs verified against the GitHub API with human-readable version comments:
   - `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683` (# v4.2.2)
   - `actions/setup-node@39370e3970a6d050c480ffad4ff0ed4d3fdee5af` (# v4.1.0)
   - `actions/setup-python@0a5c61591373683505ea898e09a3ea4f39ef2b9c` (# v5.0.0)
   - `gitleaks/gitleaks-action@f586c14365d4643c6aa59d472ae6e984bf47bb34` (# v2.3.8)
   - `aquasecurity/trivy-action@18f2510ee396bbf400402947b394f2dd8c87dbb0` (# v0.29.0)
2. **Read-Only Permissions:** Top-level workflow strictly declares `permissions: contents: read`.
3. **No External Secrets in CI:** External LLM and crawler keys are completely absent.
4. **Environment Isolation Guard:** `backend/src/config/env.ts` contains an automated boot guard that throws a fatal error if `NODE_ENV === 'test'` attempts to connect to the development database (`5433` or `/resumatch`).
