# ResuMatch AI — Continuous Integration & Quality Gates Specification

## 1. Overview & Core Philosophy

ResuMatch AI enforces strict quality and reliability gates on all pull requests and branch pushes. CI is designed to:
1. **Prevent Regressions:** Automatically catch type mismatches, broken tests, security vulnerabilities, and ranking accuracy regressions before code merges.
2. **Strict Isolation:** Run all integration tests against isolated ephemeral containers (`docker-compose.ci.yml` / GitHub Actions service containers) on non-conflicting ports, guaranteeing **zero modification** to local development databases.
3. **Zero Secrets in CI:** External LLM (OpenRouter/Gemini/Groq) and web crawler (Firecrawl) keys are disabled (`EMPTY`) in CI. All evaluations and integration tests execute deterministically using local embedding models, deterministic scoring pipelines, and synthetic fixtures.
4. **Local Parity:** Any CI failure can be reproduced locally with byte-for-byte fidelity using `./scripts/ci-local.ps1` (PowerShell) or `./scripts/ci-local.sh` (Bash).

---

## 2. GitHub Actions Workflow Matrix (`.github/workflows/ci.yml`)

The CI workflow triggers on pushes to `main`, `master`, and `queue/**`, as well as all pull requests targeting `main` or `master`. It declares top-level `permissions: contents: read` and concurrency cancellation for out-of-date runs.

| Job Name | Runner / Environment | Key Verification Steps | Pass / Fail Criteria |
| :--- | :--- | :--- | :--- |
| **`backend-ci`** | `ubuntu-latest`<br>Node 22, PG 16, Redis 7 | `npm ci`<br>`prisma validate`<br>`prisma db push`<br>`npm run build`<br>`npm test` | All 398+ Vitest tests must pass. Prisma schema must validate. TypeScript compilation must succeed with 0 errors. |
| **`frontend-ci`** | `ubuntu-latest`<br>Node 22 | `npm ci`<br>`npm run typecheck`<br>`npm test`<br>`npm run build` | Next.js 15 typecheck must pass. All 129 Vitest tests pass. Next.js standalone production build must succeed. |
| **`ml-ci`** | `ubuntu-latest`<br>Python 3.11, Tesseract OCR | `pip install`<br>`ruff check ml`<br>`mypy ml`<br>`pytest ml/tests` | Zero Ruff lint violations. Zero Mypy typecheck errors. All 217+ Pytest unit & integration tests pass. |
| **`ml-eval-gate`** | `ubuntu-latest`<br>Python 3.11 (Needs `ml-ci`) | `python -m ml.eval.gate` | Pairwise ordering accuracy >= 83.00%. Strong candidate mean >= 60.0. Weak candidate mean <= 45.0. Label separation gap >= 20.0 pts. |
| **`security-ci`** | `ubuntu-latest` | `gitleaks/gitleaks-action` | Scans full repository commit history for unredacted API keys, passwords, or tokens. |

---

## 3. Dependency Automation (`.github/dependabot.yml`)

Dependabot automatically scans and files weekly dependency update PRs across:
- **`backend` (npm):** Node.js dependencies, Fastify ecosystem, Prisma, BullMQ.
- **`frontend` (npm):** Next.js, React, Tailwind CSS, Lucide icons.
- **`ml` (pip):** FastAPI, PyTorch, PyMuPDF, SentenceTransformers, Pillow.
- **`github-actions`:** GitHub Actions workflows and SHA-pinned runner actions.

---

## 4. Local Reproduction & Parity

To run the exact same CI pipeline locally before pushing:

### Windows (PowerShell)
```powershell
.\scripts\ci-local.ps1
```

### Linux / macOS (Bash)
```bash
chmod +x ./scripts/ci-local.sh
./scripts/ci-local.sh
```

### How Local Parity Works:
1. Spawns an ephemeral stack defined in `docker-compose.ci.yml`:
   - Isolated PostgreSQL instance on port `55432` with `tmpfs: /var/lib/postgresql/data` (RAM disk; completely destroyed on exit).
   - Isolated Redis instance on port `56379` with `tmpfs: /data`.
   - Isolated MinIO instance on port `59000`.
2. Connects to `55432` to run database migrations and the full Vitest suite.
3. Automatically tears down the ephemeral containers on exit without touching local development containers or databases.

---

## 5. Security & Secret Protection Standard

1. **SHA Pinning:** All third-party GitHub Actions are pinned to full immutable commit SHAs with human-readable version comments (e.g. `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`).
2. **Read-Only Permissions:** The top-level workflow strictly limits permissions to `contents: read`.
3. **No Environment Variables with Secrets:** No `.env` files are tracked in git; all test environments supply ephemeral dummy credentials (`supersecretjwtkeyforciqualitygate123456789012`).
4. **Boot Guard Verification:** Production boot guards prevent application startup if default or insecure secrets are configured in `NODE_ENV=production`.
