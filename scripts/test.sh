#!/usr/bin/env bash
set -e

echo "🧪 Running Tests across all services..."
echo "==> [1/3] Backend Vitest Suite:"
(cd backend && npm test)

echo "==> [2/3] ML Pytest Suite:"
python -m pytest ml/tests

echo "==> [3/3] Frontend Vitest Suite:"
(cd frontend && npm test)

echo "✅ All test suites passed successfully!"
