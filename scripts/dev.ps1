Write-Host "🚀 Launching ResuMatch AI Infrastructure (Postgres, Redis, MinIO)..." -ForegroundColor Cyan
docker compose up -d postgres redis minio minio-setup
Write-Host "✓ Infrastructure containers active." -ForegroundColor Green
