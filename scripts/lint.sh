#!/usr/bin/env bash
set -e

echo "🔍 Running Linters & Typecheck across all services..."
echo "==> [1/3] Backend Typecheck & Build:"
(cd backend && npm run build)

echo "==> [2/3] ML Ruff & Mypy:"
python -m ruff check ml
python -m mypy --config-file ml/pyproject.toml ml

echo "==> [3/3] Frontend Typecheck:"
(cd frontend && npm run typecheck)

echo "✅ All services passed lint and typecheck!"
