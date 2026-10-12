import time
from typing import Any

import psycopg

from ml.config import settings


def check_database_health() -> dict[str, Any]:
    """
    Checks PostgreSQL connection and verifies pgvector extension status using raw SQL.
    Does NOT manage schemas or migrations (Prisma owns migrations).
    """
    start_time = time.perf_counter()
    try:
        with psycopg.connect(settings.database_url, connect_timeout=3) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1;")
                cur.execute("SELECT 1 FROM pg_extension WHERE extname = 'vector';")
                has_vector = cur.fetchone() is not None

        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "status": "healthy" if has_vector else "degraded",
            "latency_ms": latency_ms,
            "pgvector_extension": "installed" if has_vector else "missing",
        }
    except Exception as exc:
        latency_ms = round((time.perf_counter() - start_time) * 1000, 2)
        return {
            "status": "unhealthy",
            "latency_ms": latency_ms,
            "error": str(exc),
        }
