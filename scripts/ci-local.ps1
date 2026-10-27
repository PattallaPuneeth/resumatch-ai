param(
    [switch]$SkipTearDown,
    [switch]$BackendOnly,
    [switch]$MlOnly,
    [switch]$FrontendOnly
)

$ErrorActionPreference = "Stop"
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName

Write-Host "==> [CI-Local] Starting isolated ephemeral CI environment..." -ForegroundColor Cyan

# Bring up CI services
docker compose -p resumatch-ci -f "$repoRoot/docker-compose.ci.yml" up -d --wait postgres redis minio
if ($LASTEXITCODE -ne 0) {
    Write-Error "Failed to start CI dependencies"
    exit 1
}
docker compose -p resumatch-ci -f "$repoRoot/docker-compose.ci.yml" up minio-setup

# Define isolated connection parameters (non-secret test credentials committed for CI)
$ciDbPort = "55432"
$ciRedisPort = "56379"
$ciMinioPort = "59000"
$ciDbUser = "ci_test_user"
$ciDbPass = "ci_test_password_123"
$ciDbName = "resumatch_ci_test"
$ciMinioUser = "ci_minio_user"
$ciMinioPass = "ci_minio_password_123"

$env:DATABASE_URL = "postgresql://${ciDbUser}:${ciDbPass}@127.0.0.1:${ciDbPort}/${ciDbName}?schema=public"
$env:REDIS_HOST = "127.0.0.1"
$env:REDIS_PORT = $ciRedisPort
$env:REDIS_URL = "redis://127.0.0.1:${ciRedisPort}"
$env:MINIO_ENDPOINT = "127.0.0.1"
$env:MINIO_PORT = $ciMinioPort
$env:MINIO_USE_SSL = "false"
$env:MINIO_ACCESS_KEY = $ciMinioUser
$env:MINIO_SECRET_KEY = $ciMinioPass
$env:MINIO_BUCKET_NAME = "resumes"
$env:S3_ENDPOINT = "http://127.0.0.1:${ciMinioPort}"
$env:S3_PUBLIC_ENDPOINT = "http://127.0.0.1:${ciMinioPort}"
$env:S3_REGION = "us-east-1"
$env:S3_BUCKET = "resumes"
$env:S3_ACCESS_KEY = $ciMinioUser
$env:S3_SECRET_KEY = $ciMinioPass
$env:S3_FORCE_PATH_STYLE = "true"
$env:NODE_ENV = "test"
$env:JWT_SECRET = "test-fake-jwt-secret-for-vitest-runs-only-32chars"
$env:INTERNAL_API_TOKEN = "test-fake-internal-api-token-vitest-32chars"

Write-Host "[CI Isolation] Target ports: DB 127.0.0.1:$ciDbPort, Redis 127.0.0.1:$ciRedisPort, MinIO 127.0.0.1:$ciMinioPort" -ForegroundColor Green

# 1. Run migrations against empty DB
Write-Host "==> [CI-Local] Running prisma migrate deploy on clean CI database..." -ForegroundColor Yellow
Push-Location "$repoRoot/backend"
try {
    npx prisma migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "Migration failed on CI database" }
} finally {
    Pop-Location
}

$backendExit = 0
$mlExit = 0
$frontendExit = 0

try {
    if (-not $MlOnly -and -not $FrontendOnly) {
        Write-Host "==> [CI-Local] Running Backend Vitest Suite against isolated CI ports..." -ForegroundColor Yellow
        Push-Location "$repoRoot/backend"
        try {
            npx vitest run
            $backendExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }

    if (-not $BackendOnly -and -not $FrontendOnly) {
        Write-Host "==> [CI-Local] Running ML Pytest Suite (-m 'not live')..." -ForegroundColor Yellow
        Push-Location "$repoRoot/ml"
        try {
            docker compose exec ml pytest -m "not live"
            $mlExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }

    if (-not $BackendOnly -and -not $MlOnly) {
        Write-Host "==> [CI-Local] Running Frontend Vitest Suite..." -ForegroundColor Yellow
        Push-Location "$repoRoot/frontend"
        try {
            npm test
            $frontendExit = $LASTEXITCODE
        } finally {
            Pop-Location
        }
    }
} finally {
    if (-not $SkipTearDown) {
        Write-Host "==> [CI-Local] Tearing down ephemeral CI environment..." -ForegroundColor Cyan
        docker compose -p resumatch-ci -f "$repoRoot/docker-compose.ci.yml" down
    }
}

if ($backendExit -ne 0 -or $mlExit -ne 0 -or $frontendExit -ne 0) {
    Write-Host "FAILED: One or more test suites failed." -ForegroundColor Red
    exit 1
}

Write-Host "SUCCESS: All test suites passed in isolated CI environment!" -ForegroundColor Green
