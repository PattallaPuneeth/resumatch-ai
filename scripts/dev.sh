#!/usr/bin/env bash
set -e
echo "🚀 Launching ResuMatch AI Infrastructure (Postgres, Redis, MinIO)..."
docker compose up -d postgres redis minio minio-setup
echo "✓ Infrastructure containers active."
