# ADR 003: Hybrid retrieval with a cross-encoder, not vector search alone

**Status:** Accepted

## Context
A match must find the resume passages that support each requirement of a job description. Technical
text breaks pure embedding search: exact terms such as "Kubernetes", "K8s" or "pgvector" matter,
and a dense model can rank a vaguely similar passage above one that names the skill.

## Decision
Retrieve with two legs and fuse them:
1. **Lexical:** PostgreSQL full-text search (`tsvector`, `ts_rank_cd`) with an OR query.
2. **Semantic:** pgvector cosine search over chunk embeddings.
3. **Fusion:** Reciprocal Rank Fusion (k = 60), which needs no score calibration between legs.
4. **Rerank:** `cross-encoder/ms-marco-MiniLM-L-6-v2` over the top 20 passages.
5. **Blend:** `0.65 x cross-encoder + 0.25 x skill coverage + 0.10 x vector`, scaled to 0 to 100.
   Skill coverage uses a curated alias taxonomy (K8s = Kubernetes, and so on) with word-boundary
   matching.

Scores come only from this deterministic pipeline. The LLM explains and rewrites but never
produces or changes a number (roadmap rule 11).

## Why
- Lexical search guarantees exact skill names are not lost; semantic search covers paraphrase.
- RRF is rank-based, so it fuses BM25-style and cosine scores without tuning their scales.
- The cross-encoder reads the query and passage together, which fixes ordering errors the
  bi-encoder makes.
- Each stage is measurable. `ml/eval` has an ablation harness and a CI gate (`ml.eval.gate`)
  that blocks regressions in pairwise ordering accuracy.

## Costs and honest limits
- With one resume against one job there are only about five chunks, so fusion and reranking add
  little there. They matter for cross-resume discovery and job suggestions.
- Reranking is CPU-bound and is the main cause of missed latency targets under sustained load
  ([docs/PERFORMANCE.md](../PERFORMANCE.md)).
- Ranking within a job is fair, but strong/medium/weak band accuracy is about 49% on 180
  human-labeled pairs (README, Limitations). The retrieval design is not the limiting factor.
- A larger reranker, a stronger embedder and an int8-quantized reranker were measured and rejected
  within the 2 GB worker budget ([ML failure analysis](../eval/ML_FAILURE_ANALYSIS.md)).

## Revisit when
Labeled data shows a different weighting, or a model that fits the memory budget improves band
accuracy.
