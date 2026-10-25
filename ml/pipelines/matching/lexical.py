"""
Phase 3B: Sparse Lexical Search (BM25-style full-text search).

Uses PostgreSQL to_tsvector('english', content) and an OR-style to_tsquery,
matching the exact expression in the GIN index resume_chunks_content_tsv_idx.
Uses ts_rank_cd as a BM25-style lexical proximity/frequency signal.
"""

from __future__ import annotations

import logging
from typing import Any

import psycopg
from ml.config import settings

logger = logging.getLogger("resumatch-ml-lexical")


def build_or_tsquery(text: str, conn: psycopg.Connection) -> str | None:
    """
    Extracts stemmed English lexemes using PostgreSQL's own English text analysis
    and joins them with ' | ' to produce an OR-style tsquery.

    OR semantics ensure that long job descriptions with diverse requirements
    still return lexical hits without demanding every word to appear simultaneously
    (which would happen with plainto_tsquery's AND semantics).
    """
    if not text or not text.strip():
        return None

    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT array_to_string(
                    ARRAY(
                        SELECT DISTINCT quote_literal(elem)
                        FROM unnest(tsvector_to_array(to_tsvector('english', %s))) AS elem
                        WHERE length(elem) >= 2
                        LIMIT 200
                    ),
                    ' | '
                );
                """,
                (text,),
            )
            row = cur.fetchone()
            if not row or not row[0]:
                return None
            return str(row[0])
    except Exception as e:
        logger.exception("Failed to build OR tsquery from text: %s", e)
        raise


def search_lexical(
    query_text: str,
    resume_id: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """
    Executes sparse lexical search against resume_chunks.

    Args:
        query_text: Text from job title, description, or required skills.
        resume_id: Optional resume ID filter. If provided, scores only chunks of that resume.
        limit: Maximum number of chunks to return.

    Returns:
        List of dicts: {chunk_id, resume_id, chunk_index, section_type, content, score, rank}
    """
    if not query_text or not query_text.strip():
        return []

    try:
        with psycopg.connect(settings.database_url) as conn:
            query_str = build_or_tsquery(query_text, conn)
            if not query_str:
                return []

            with conn.cursor() as cur:
                # Expression matches the GIN index definition: to_tsvector('english', content).
                # Note: In single-resume queries (with resume_id), PostgreSQL optimizer uses
                # resume_chunks_resumeId_idx (B-tree) and filters by tsquery, which is optimal
                # for the few chunks of a single candidate. GIN accelerates cross-resume discovery.
                sql = """
                SELECT
                    id,
                    "resumeId",
                    "chunkIndex",
                    "sectionType",
                    content,
                    ts_rank_cd(
                        to_tsvector('english', content),
                        to_tsquery('english', %(q)s),
                        32
                    ) AS lexical_score
                FROM resume_chunks
                WHERE (%(resume_id)s::text IS NULL OR "resumeId" = %(resume_id)s)
                  AND to_tsvector('english', content) @@ to_tsquery('english', %(q)s)
                ORDER BY lexical_score DESC
                LIMIT %(limit)s;
                """
                cur.execute(sql, {"q": query_str, "resume_id": resume_id, "limit": limit})
                rows = cur.fetchall()

                results: list[dict[str, Any]] = []
                for rank_idx, row in enumerate(rows, start=1):
                    results.append(
                        {
                            "chunk_id": str(row[0]),
                            "resume_id": str(row[1]),
                            "chunk_index": int(row[2]),
                            "section_type": str(row[3]),
                            "content": str(row[4]),
                            "score": float(row[5]),
                            "rank": rank_idx,
                        }
                    )
                return results

    except Exception as e:
        logger.exception("Lexical search failed: %s", e)
        raise
