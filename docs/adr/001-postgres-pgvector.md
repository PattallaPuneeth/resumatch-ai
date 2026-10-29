# ADR 001: PostgreSQL with pgvector, not a separate vector database

**Status:** Accepted

## Context
Each resume is split into chunks (160 to 240 tokens) and embedded with `all-MiniLM-L6-v2` (384
dimensions). Matching must combine vector search with relational filters: the chunks belong to one
user's resume, the resume has a status, and every read must respect ownership.

## Decision
Store embeddings in PostgreSQL 16 with the `pgvector` extension, indexed with HNSW (cosine). The
same database holds users, resumes, jobs, matches and usage meters.

## Why
- **One source of truth.** A resume delete cascades to its chunks and vectors in one transaction.
  With a separate vector store, a failed second delete leaves orphan vectors that still match.
- **Filtering is a `WHERE` clause.** Ownership and resume scoping are joins, not metadata filters
  that must be kept in sync across two systems.
- **Lexical and vector search share an engine.** The `tsvector` full-text leg and the vector leg
  of hybrid retrieval ([ADR 003](003-hybrid-retrieval.md)) run in the same query planner.
- **Less to run.** One database to back up, migrate (Prisma) and secure. `docs/RULE.md` rule 7
  forbids extra databases without a demonstrated need.
- **Scale fits.** A single resume has about five chunks, so most queries scan a handful of rows;
  HNSW only matters for cross-resume discovery.

## Costs
- Vector search shares CPU and memory with transactional traffic.
- pgvector has fewer index and quantization options than dedicated engines.
- The embedding dimension is fixed in the schema, so changing the embedder needs a migration and
  a re-embed.

## Revisit when
Cross-resume vector search over millions of chunks becomes a measured bottleneck, or vector load
starts to hurt transactional latency. At that point move only the vector leg, keep Postgres as the
source of truth, and treat the vector store as a rebuildable index.
