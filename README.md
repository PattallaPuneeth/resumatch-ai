# ResuMatch AI

An AI-powered resume analysis and job-matching platform that simulates ATS parsing, identifies resume improvement opportunities, generates fact-grounded bullet rewrites, and matches candidates with relevant job opportunities using hybrid search (BM25 + vector similarity), Reciprocal Rank Fusion (RRF), and cross-encoder reranking. Features explainable match scores, skill-gap analysis, and privacy-conscious resume processing.

---

## 🏛 Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │          React Frontend (Vite)         │
                      └───────────────────┬────────────────────┘
                                          │ HTTP (REST)
                                          ▼
                      ┌────────────────────────────────────────┐
                      │         Fastify Backend (Node)         │
                      │   - TypeScript (Strict)                │
                      │   - Zod Environment Validation         │
                      │   - Pino Structured Logging            │
                      │   - Prisma ORM                         │
                      └───────┬───────────┬────────────┬───────┘
                              │           │            │
             Postgres pgvector│           │Redis/BullMQ│MinIO S3
                              ▼           ▼            ▼
             ┌──────────────────┐ ┌─────────────┐ ┌──────────────┐
             │ PostgreSQL 16    │ │   Redis 7   │ │   MinIO S3   │
             │ - pgvector (384) │ │  (Queues &  │ │(Raw Resumes, │
             │ - HNSW Indexes   │ │   Caching)  │ │ Attachments) │
             │ - tsvector GIN   │ └───────┬─────┘ └──────────────┘
             └──────────────────┘         │
                                          │ Worker Jobs / HTTP
                                          ▼
                               ┌─────────────────────┐
                               │  FastAPI ML Service │
                               │  - ATS Parsing      │
                               │  - Embeddings (384) │
                               │  - Hybrid Search    │
                               │  - Cross-Encoder    │
                               └─────────────────────┘
```

---

## 🚀 Phase 1 Foundation

This phase establishes the bedrock foundation of ResuMatch AI:
- **Fastify Backend**: Pure TypeScript strict mode, Pino logging, Zod runtime env validation, centralized RFC 7807-compliant error handler.
- **Health Verification**: `GET /health` endpoint probing PostgreSQL, Redis, and MinIO connectivity and response latencies.
- **Prisma Schema**: Data models for `User`, `Resume`, `Analysis`, `ParsedResume`, `ResumeChunk`, `Job`, `JobChunk`, `Match`, and `AuditLog`.
- **Vector Search Engine**: PostgreSQL with `pgvector` (384-dimensional embeddings matching sentence-transformers / all-MiniLM-L6-v2), HNSW cosine indexes, and full-text GIN search indexes.
- **Object Storage**: S3-compatible MinIO for resume files and parsed artifacts with auto-provisioning bucket setup.
- **Queueing Engine**: BullMQ + Redis 7 for asynchronous parsing, embedding generation, and scoring jobs.
- **Contract Specifications**: Strict Node.js <-> Python ML HTTP and Queue contracts in [`docs/contracts.md`](docs/contracts.md).
- **Endpoint Stubs**: Feature route stubs returning HTTP `501 Not Implemented` with JSON bodies (`/resumes`, `/analyses`, `/jobs`).
- **Test Suite**: Vitest configured with route stub and health check unit tests.

---

## 🛠 Tech Stack

| Domain | Technology |
|---|---|
| **Backend API** | Node.js (v20+), Fastify, TypeScript (Strict), Pino, Zod |
| **Database** | PostgreSQL 16 with `pgvector` extension |
| **ORM & Migrations** | Prisma ORM with native vector extensions |
| **Job Queue & Cache** | Redis 7, BullMQ |
| **Object Storage** | MinIO (S3 compatible) |
| **Testing** | Vitest |
| **ML Engine (Planned)** | Python 3.11, FastAPI, Pydantic, sentence-transformers |
| **Frontend (Planned)** | Vite, React, TypeScript |

---

## 📋 Getting Started

### 1. Prerequisites
- [Docker](https://www.docker.com/) & Docker Compose
- [Node.js](https://nodejs.org/) (v20 or higher)
- [npm](https://www.npmjs.com/) (v10 or higher)

### 2. Environment Setup
Copy the environment variables template:
```bash
cp .env.example .env
```

### 3. Spin Up Infrastructure
Launch Postgres (`pgvector:pg16`), Redis 7, MinIO, and bucket initialization:
```bash
docker compose up -d postgres redis minio minio-setup
```

### 4. Backend Setup & Run
```bash
cd backend
npm install
npm run db:generate   # Generates Prisma Client
npm run build         # Validates TypeScript strict compilation
npm test              # Runs Vitest test suite
npm run dev           # Starts Fastify in development mode
```

The backend server starts on `http://localhost:4000`.

---

## 🔍 API Endpoints (Phase 1)

| Method | Endpoint | Status | Description |
|---|---|---|---|
| `GET` | `/health` | `200` / `503` | Probes PostgreSQL, Redis, and MinIO connectivity |
| `*` | `/resumes` | `501` | Resume upload and management stub |
| `*` | `/analyses` | `501` | ATS analysis and bullet rewriting stub |
| `*` | `/jobs` | `501` | Job descriptions and matching stub |

---

## 📜 Database Migrations & Vector Indexing

The initial migration establishes:
- `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- HNSW Cosine distance indexing on `ResumeChunk.embedding` (384 dimensions)
- HNSW Cosine distance indexing on `JobChunk.embedding` (384 dimensions)
- GIN index on `to_tsvector('english', content)` for BM25 hybrid search

Run migrations against a running database:
```bash
cd backend
npx prisma migrate dev --name init_vector_hnsw_tsvector
```

---

## 📄 License

Proprietary / CBP Project - All Rights Reserved.