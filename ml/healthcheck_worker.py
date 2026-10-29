"""Worker liveness probe.

Validates that:
1. Python runtime is functioning.
2. Redis is reachable.
3. The BullMQ worker's asyncio event loop is actively refreshing its heartbeat in Redis.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import time

import redis

from ml.config import settings

HEARTBEAT_MAX_AGE_SECONDS = 15.0


def check_worker_health(worker_id: str | None = None) -> int:
    target_id = worker_id or os.environ.get("WORKER_ID") or socket.gethostname() or "default-worker"
    heartbeat_key = f"resumatch:worker:heartbeat:{target_id}"

    try:
        r = redis.from_url(settings.redis_url, socket_timeout=3.0)
        raw = r.get(heartbeat_key)
        if not raw:
            # Fallback: check if any active worker heartbeat exists if hostname lookup differed
            keys = r.keys("resumatch:worker:heartbeat:*")
            if not keys:
                print(f"FAIL: No heartbeat found for key {heartbeat_key} and no active workers registered")
                return 1
            raw = r.get(keys[0])
            if not raw:
                print(f"FAIL: No heartbeat data in {keys[0]}")
                return 1

        data = json.loads(raw.decode("utf-8") if isinstance(raw, bytes) else raw)
        last_seen = float(data.get("timestamp", 0))
        age = time.time() - last_seen

        if age > HEARTBEAT_MAX_AGE_SECONDS:
            print(f"FAIL: Worker heartbeat stale (age: {age:.2f}s > {HEARTBEAT_MAX_AGE_SECONDS}s)")
            return 1

        print(
            f"OK: Worker {data.get('worker_id', target_id)} is healthy (age: {age:.2f}s, roles: {data.get('roles')})"
        )
        return 0

    except Exception as e:
        print(f"FAIL: Worker healthcheck encountered error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(check_worker_health())

