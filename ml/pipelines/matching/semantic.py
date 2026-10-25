"""
Phase 3B: Dense Semantic Search (pgvector cosine-distance search).

Queries resume_chunks using the pgvector <=> cosine-distance operator
and the HNSW cosine index resume_chunks_embedding_hnsw_idx.
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg
from ml.config import settings
from ml.pipelines.embeddings.embedder import generate_embeddings
from pgvector.psycopg import register_vector  # type: ignore[import-untyped]

logger = logging.getLogger("resumatch-ml-semantic")


def search_semantic(
    query_text_or_embedding: str | list[float],
    resume_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """
    Executes dense semantic search against resume_chunks using cosine distance (<=>).

    Args:
        query_text_or_embedding: Either raw text query or pre-computed 384-dim embedding vector.
        resume_id: Optional resume ID filter. If provided, limits search to chunks of that resume.
        limit: Maximum number of chunks to return.

    Returns:
        List of dicts:
        {chunk_id, resume_id, chunk_index, section_type, content, score, distance, rank}
    """
    if isinstance(query_text_or_embedding, str):
        if not query_text_or_embedding.strip():
            return []
        vectors = generate_embeddings([query_text_or_embedding])
        if not vectors:
            return []
        query_vec = vectors[0]
    else:
        query_vec = query_text_or_embedding

    if len(query_vec) != 384:
        raise ValueError(f"Expected 384-dimensional query vector, got {len(query_vec)}")

    try:
        with psycopg.connect(settings.database_url) as conn:
            register_vector(conn)
            with conn.cursor() as cur:
                sql = """
                SELECT
                    id,
                    "resumeId",
                    "chunkIndex",
                    "sectionType",
                    content,
                    (embedding <=> %(vec)s::vector) AS distance,
                    1 - (embedding <=> %(vec)s::vector) AS similarity
                FROM resume_chunks
                WHERE (%(resume_id)s::text IS NULL OR "resumeId" = %(resume_id)s)
                  AND embedding IS NOT NULL
                ORDER BY embedding <=> %(vec)s::vector ASC
                LIMIT %(limit)s;
                """
                cur.execute(sql, {"vec": query_vec, "resume_id": resume_id, "limit": limit})
                rows = cur.fetchall()

                results: list[dict[str, Any]] = []
                for rank_idx, row in enumerate(rows, start=1):
                    distance = float(row[5])
                    similarity = float(row[6])
                    results.append(
                        {
                            "chunk_id": str(row[0]),
                            "resume_id": str(row[1]),
                            "chunk_index": int(row[2]),
                            "section_type": str(row[3]),
                            "content": str(row[4]),
                            "distance": distance,
                            "score": similarity,
                            "rank": rank_idx,
                        }
                    )
                return results

    except Exception as e:
        logger.exception("Semantic search failed: %s", e)
        raise
