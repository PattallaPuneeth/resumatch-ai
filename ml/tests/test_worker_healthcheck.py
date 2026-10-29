import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ml.healthcheck_worker import check_worker_health
from ml.worker import run_heartbeat_loop


def test_check_worker_health_success():
    fake_payload = json.dumps({
        "worker_id": "test-worker-1",
        "roles": ["parse", "embed"],
        "timestamp": time.time(),
        "status": "healthy",
        "pid": 1234,
    }).encode("utf-8")

    mock_redis = MagicMock()
    mock_redis.get.return_value = fake_payload

    with patch("redis.from_url", return_value=mock_redis):
        code = check_worker_health(worker_id="test-worker-1")
        assert code == 0


def test_check_worker_health_stale():
    fake_payload = json.dumps({
        "worker_id": "test-worker-1",
        "roles": ["parse"],
        "timestamp": time.time() - 30.0,  # 30 seconds ago (stale)
        "status": "healthy",
        "pid": 1234,
    }).encode("utf-8")

    mock_redis = MagicMock()
    mock_redis.get.return_value = fake_payload

    with patch("redis.from_url", return_value=mock_redis):
        code = check_worker_health(worker_id="test-worker-1")
        assert code == 1


def test_check_worker_health_missing():
    mock_redis = MagicMock()
    mock_redis.get.return_value = None
    mock_redis.keys.return_value = []

    with patch("redis.from_url", return_value=mock_redis):
        code = check_worker_health(worker_id="test-worker-1")
        assert code == 1


def test_check_worker_health_redis_connection_error():
    with patch("redis.from_url", side_effect=Exception("Redis connection refused")):
        code = check_worker_health(worker_id="test-worker-1")
        assert code == 1


@pytest.mark.asyncio
async def test_heartbeat_loop_writes_and_cleans_up():
    mock_client = AsyncMock()
    mock_client.set = AsyncMock()
    mock_client.delete = AsyncMock()
    mock_client.aclose = AsyncMock()

    with patch("redis.asyncio.from_url", return_value=mock_client), \
         patch("ml.worker._should_exit", False):
        task = asyncio.create_task(run_heartbeat_loop("test-worker-1", {"parse", "match"}))
        await asyncio.sleep(0.05)  # Let it run one iteration
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    assert mock_client.set.call_count >= 1
    call_args = mock_client.set.call_args[0]
    key = call_args[0]
    payload = json.loads(call_args[1])
    assert key == "resumatch:worker:heartbeat:test-worker-1"
    assert payload["worker_id"] == "test-worker-1"
    assert payload["roles"] == ["match", "parse"]
    assert payload["status"] == "healthy"
    assert mock_client.delete.called
    assert mock_client.aclose.called

