#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/ci-local.sh [--backend-only]
BACKEND_ONLY=0
[[ "${1:-}" == "--backend-only" ]] && BACKEND_ONLY=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "==> [CI-Local] Starting isolated ephemeral CI environment..."
docker compose -p resumatch-ci -f "$REPO_ROOT/docker-compose.ci.yml" up -d --wait postgres redis minio
docker compose -p resumatch-ci -f "$REPO_ROOT/docker-compose.ci.yml" up minio-setup

CI_DB_PORT="55432"
CI_REDIS_PORT="56379"
CI_MINIO_PORT="59000"
CI_DB_USER="ci_test_user"
CI_DB_PASS="ci_test_password_123"
CI_DB_NAME="resumatch_ci_test"
CI_MINIO_USER="ci_minio_user"
CI_MINIO_PASS="ci_minio_password_123"

export DATABASE_URL="postgresql://${CI_DB_USER}:${CI_DB_PASS}@127.0.0.1:${CI_DB_PORT}/${CI_DB_NAME}?schema=public"
export REDIS_HOST="127.0.0.1"
export REDIS_PORT="$CI_REDIS_PORT"
export REDIS_URL="redis://127.0.0.1:${CI_REDIS_PORT}"
export MINIO_ENDPOINT="127.0.0.1"
export MINIO_PORT="$CI_MINIO_PORT"
export MINIO_USE_SSL="false"
export MINIO_ACCESS_KEY="$CI_MINIO_USER"
export MINIO_SECRET_KEY="$CI_MINIO_PASS"
export MINIO_BUCKET_NAME="resumes"
export S3_ENDPOINT="http://127.0.0.1:${CI_MINIO_PORT}"
export S3_PUBLIC_ENDPOINT="http://127.0.0.1:${CI_MINIO_PORT}"
export S3_REGION="us-east-1"
export S3_BUCKET="resumes"
export S3_ACCESS_KEY="$CI_MINIO_USER"
export S3_SECRET_KEY="$CI_MINIO_PASS"
export S3_FORCE_PATH_STYLE="true"
export NODE_ENV="test"
export JWT_SECRET="test-fake-jwt-secret-for-vitest-runs-only-32chars"
export INTERNAL_API_TOKEN="test-fake-internal-api-token-vitest-32chars"

echo "[CI Isolation] Target ports: DB 127.0.0.1:$CI_DB_PORT, Redis 127.0.0.1:$CI_REDIS_PORT, MinIO 127.0.0.1:$CI_MINIO_PORT"

cleanup() {
  echo "==> [CI-Local] Tearing down ephemeral CI environment..."
  docker compose -p resumatch-ci -f "$REPO_ROOT/docker-compose.ci.yml" down
}
trap cleanup EXIT

echo "==> [CI-Local] Running prisma migrate deploy on clean CI database..."
(cd "$REPO_ROOT/backend" && npx prisma migrate deploy)

echo "==> [CI-Local] Running Backend Vitest Suite against isolated CI ports..."
(cd "$REPO_ROOT/backend" && npx vitest run)

if [[ "$BACKEND_ONLY" == "1" ]]; then
  exit 0
fi

echo "==> [CI-Local] Running ML Pytest Suite (-m 'not live')..."
docker compose exec ml pytest -m "not live"

echo "==> [CI-Local] Running Frontend Vitest Suite..."
(cd "$REPO_ROOT/frontend" && npm test)

echo "SUCCESS: All test suites passed in isolated CI environment!"
