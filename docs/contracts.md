# Node.js (Fastify) ⟷ Python (FastAPI / ML) Service Contract

This document defines the strict communication and data contracts between the **ResuMatch AI Backend** (Node.js / Fastify) and the **ML Microservice** (Python / FastAPI / PyTorch / Transformers).

All runtime data exchanged over HTTP REST or BullMQ Redis Queues **must** conform to the Zod (TypeScript) and Pydantic (Python) schemas outlined here.

---

## 1. Architecture & Protocol Topology

```
+--------------------+                     +--------------------+
|   Fastify Node.js  |                     |   FastAPI Python   |
|   Backend Service  |                     |     ML Service     |
+---------+----------+                     +---------+----------+
          |                                          |
          |--- [HTTP POST /v1/embeddings] ---------->| (Sync, low latency)
          |<-- [200 OK: 384-dim Vectors] ------------|
          |                                          |
          |--- [HTTP POST /v1/rerank] -------------->| (Sync, cross-encoder)
          |<-- [200 OK: Reranked Matches] -----------|
          |                                          |
          |                                          |
          |========= [Redis: resume-parse] =========>| (Async queue via
          |<======== [Redis: resume-parse-done] =====|  BullMQ/Worker)
```

---

## 2. Shared Vector Configuration
- **Model Standard**: `sentence-transformers/all-MiniLM-L6-v2` (or compatible 384-dim dense representation)
- **Vector Dimension**: Exactly `384`
- **Metric**: Cosine Distance (`vector_cosine_ops` in PostgreSQL HNSW index)
- **Embedding Format**: Array of 384 floating point numbers (`number[]` / `List[float]`), L2 normalized.

---

## 3. Endpoints & Schemas

### 3.1 Text Embedding Service

#### `POST /v1/embeddings`
Generates normalized 384-dimensional dense vectors for chunks of text.

##### Request Schema (Zod / Pydantic)
```json
{
  "texts": [
    "Experienced software engineer proficient in TypeScript, React, Node.js, and PostgreSQL.",
    "Led migration of monolith backend to distributed microservices architecture."
  ],
  "truncate": true
}
```

##### TypeScript Interface
```typescript
export interface EmbeddingRequest {
  texts: string[];
  truncate?: boolean; // default true (max 512 tokens)
}
```

##### Python Pydantic Model
```python
from pydantic import BaseModel, Field

class EmbeddingRequest(BaseModel):
    texts: list[str] = Field(..., min_length=1, max_length=128)
    truncate: bool = Field(default=True)
```

##### Response Schema
```json
{
  "model": "sentence-transformers/all-MiniLM-L6-v2",
  "dimension": 384,
  "embeddings": [
    [-0.0381, 0.0824, "...", 0.0192],
    [0.0125, -0.0541, "...", -0.0811]
  ],
  "usage": {
    "total_tokens": 42
  }
}
```

---

### 3.2 ATS Resume Parsing Service

#### `POST /v1/parser/extract`
Parses raw PDF/DOCX text extracted from MinIO storage into structured ATS entities.

##### Request Schema
```json
{
  "resume_id": "c1f7b8a0-2f64-4e9b-b0f3-9d4d80a1c22e",
  "raw_text": "PUNEETH PATTALLA\nSoftware Engineer\nEmail: puneeth@example.com...",
  "file_type": "pdf"
}
```

##### Response Schema
```json
{
  "resume_id": "c1f7b8a0-2f64-4e9b-b0f3-9d4d80a1c22e",
  "candidate": {
    "name": "Puneeth Pattalla",
    "email": "puneeth@example.com",
    "phone": "+1-555-0199",
    "linkedin_url": "https://linkedin.com/in/puneeth",
    "github_url": "https://github.com/puneeth",
    "location": "Bangalore, India"
  },
  "summary": "Full stack engineer specializing in AI-integrated web applications...",
  "skills": {
    "languages": ["TypeScript", "Python", "SQL", "Go"],
    "frameworks": ["Fastify", "React", "Next.js", "FastAPI"],
    "tools": ["Docker", "PostgreSQL", "Redis", "MinIO", "Git"],
    "soft_skills": ["Technical Leadership", "Agile Methodologies"]
  },
  "experience": [
    {
      "company": "Tech Corp",
      "title": "Senior Software Engineer",
      "start_date": "2023-01",
      "end_date": null,
      "current": true,
      "bullets": [
        "Architected scalable ingestion pipeline handling 10k files/minute.",
        "Integrated pgvector semantic search, cutting search latency by 45%."
      ]
    }
  ],
  "education": [
    {
      "institution": "University of Technology",
      "degree": "B.Tech in Computer Science",
      "graduation_year": 2022
    }
  ],
  "certifications": ["AWS Certified Solutions Architect"],
  "ats_compliance": {
    "score": 88.5,
    "issues": [
      {
        "severity": "WARNING",
        "category": "FORMATTING",
        "message": "Two-column layout detected; may degrade parsing in legacy ATS."
      }
    ]
  },
  "chunks": [
    {
      "section_type": "EXPERIENCE",
      "content": "Senior Software Engineer at Tech Corp...",
      "token_count": 86
    }
  ]
}
```

---

### 3.3 Hybrid Matching & Cross-Encoder Reranking

#### `POST /v1/matching/rerank`
Takes candidate items retrieved via Postgres Hybrid Search (BM25 full-text + vector similarity RRF) and scores them with a cross-encoder model (e.g., `cross-encoder/ms-marco-MiniLM-L-6-v2`).

##### Request Schema
```json
{
  "query": "Senior Backend Engineer with strong Node.js, Fastify, and PostgreSQL vector experience",
  "candidates": [
    {
      "id": "chunk-101",
      "text": "Full stack developer with 4 years in Node.js, TypeScript, PostgreSQL, and high-load APIs.",
      "bm25_rank": 1,
      "vector_rank": 2,
      "rrf_score": 0.0328
    },
    {
      "id": "chunk-102",
      "text": "Frontend developer focused on Vue.js and CSS styling animations.",
      "bm25_rank": 5,
      "vector_rank": 14,
      "rrf_score": 0.0152
    }
  ]
}
```

##### Response Schema
```json
{
  "results": [
    {
      "id": "chunk-101",
      "bm25_rank": 1,
      "vector_rank": 2,
      "rrf_score": 0.0328,
      "cross_encoder_score": 0.942,
      "final_score": 94.2,
      "relevance_explanation": "Strong semantic alignment with backend, Node.js, and PostgreSQL specifications."
    },
    {
      "id": "chunk-102",
      "bm25_rank": 5,
      "vector_rank": 14,
      "rrf_score": 0.0152,
      "cross_encoder_score": 0.183,
      "final_score": 18.3,
      "relevance_explanation": "Low match: Primarily frontend UI experience with limited backend infrastructure overlap."
    }
  ]
}
```

---

### 3.4 Fact-Grounded Bullet Rewriting

#### `POST /v1/rewriter/bullet`
Generates rewritten resume bullet points aligned to target job keywords without hallucinating unverified claims (grounded by source resume facts).

##### Request Schema
```json
{
  "original_bullet": "Worked on database performance and made queries faster.",
  "grounding_facts": [
    "Used PostgreSQL",
    "Created composite indexes",
    "Database had 500k rows",
    "Reduced query latency from 800ms to 90ms"
  ],
  "target_job_keywords": [
    "PostgreSQL",
    "Query Optimization",
    "Latency Reduction",
    "High Throughput"
  ],
  "style": "ACTION_IMPACT"
}
```

##### Response Schema
```json
{
  "original_bullet": "Worked on database performance and made queries faster.",
  "suggestions": [
    {
      "rewritten_bullet": "Optimized PostgreSQL query performance across 500k+ records by engineering composite indexes, reducing query latency by 88% (800ms to 90ms).",
      "methodology": "STAR (Action + Metric + Result)",
      "matched_keywords": ["PostgreSQL", "Query Optimization", "Latency Reduction"],
      "hallucination_check_passed": true,
      "confidence": 0.96
    }
  ]
}
```

---

## 4. BullMQ Queue Channels

| Queue Name | Producer | Consumer | Job Type | Payload |
|---|---|---|---|---|
| `resume-parsing-queue` | Fastify Backend | ML Worker | `PARSE_DOCUMENT` | `{ resumeId: string, s3Key: string, mimeType: string }` |
| `embedding-queue` | Fastify Backend | ML Worker | `GENERATE_CHUNKS` | `{ entityType: 'RESUME' \| 'JOB', entityId: string, chunks: { id: string, text: string }[] }` |
| `match-scoring-queue` | Fastify Backend | ML Worker | `CALCULATE_MATCH` | `{ resumeId: string, jobId: string }` |

---

## 5. Error Representation Contract (RFC 7807)

When an error occurs across any service boundary, the response must return:
```json
{
  "type": "https://errors.resumatch.ai/validation-error",
  "title": "Validation Error",
  "status": 422,
  "detail": "Field 'texts' must contain between 1 and 128 elements.",
  "instance": "/v1/embeddings",
  "timestamp": "2026-10-12T16:15:00.000Z"
}
```
