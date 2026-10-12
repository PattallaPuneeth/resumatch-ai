#!/usr/bin/env bash
set -e
echo "📦 Applying Prisma Database Migrations..."
(cd backend && npx prisma migrate deploy)
echo "✓ Migrations applied successfully."
