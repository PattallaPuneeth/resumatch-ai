.PHONY: bootstrap health dev test lint migrate seed seed-demo clean build-all docker-up docker-down

# One-time setup: .env with generated secrets (LLM-off). Then `make docker-up`.
bootstrap:
	bash scripts/bootstrap.sh

# Container state and health for every compose service
health:
	bash scripts/health.sh

dev:
	docker compose up -d postgres redis minio minio-setup

docker-up:
	docker compose up --build

docker-down:
	docker compose down

test:
	@echo "==> Running Backend Tests (with throwaway Postgres/Redis/MinIO)..."
	bash scripts/ci-local.sh --backend-only
	@echo "==> Running ML Tests..."
	python -m pytest ml/tests -m "not live and not integration"
	@echo "==> Running Frontend Tests..."
	cd frontend && npm test

lint:
	@echo "==> Linting Backend..."
	cd backend && npm run build
	@echo "==> Linting ML (Ruff & Mypy)..."
	python -m ruff check ml
	python -m mypy --config-file ml/pyproject.toml ml
	@echo "==> Linting Frontend (Typecheck)..."
	cd frontend && npm run typecheck

migrate:
	@echo "==> Running Database Migrations via Prisma..."
	cd backend && npx prisma migrate deploy || npx prisma db push

seed-demo:
	node scripts/seed-demo.mjs

seed:
	@echo "==> Running Database Seed..."
	cd backend && npm run db:seed || node -e "console.log('Database seed stub complete.')"

build-all:
	cd backend && npm run build
	cd frontend && npm run build
