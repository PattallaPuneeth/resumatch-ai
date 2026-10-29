import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ml.worker import (
    get_user_id_for_job,
    get_user_id_for_resume,
    publish_user_event,
)


@pytest.mark.asyncio
async def test_publish_user_event_success():
    mock_redis = AsyncMock()
    mock_redis.publish = AsyncMock(return_value=1)

    with patch("ml.worker.get_redis_pub_client", return_value=mock_redis):
        await publish_user_event(
            user_id="user-abc-123",
            event_type="RESUME_STATUS",
            data={"resumeId": "res-1", "status": "PARSED", "atsScore": 90},
        )

        mock_redis.publish.assert_called_once()
        args = mock_redis.publish.call_args[0]
        assert args[0] == "resumatch:events:user:user-abc-123"

        payload = json.loads(args[1])
        assert payload["type"] == "RESUME_STATUS"
        assert payload["data"]["resumeId"] == "res-1"
        assert payload["data"]["status"] == "PARSED"
        assert payload["data"]["atsScore"] == 90
        assert "timestamp" in payload


@pytest.mark.asyncio
async def test_publish_user_event_no_op_when_user_id_missing():
    mock_redis = AsyncMock()

    with patch("ml.worker.get_redis_pub_client", return_value=mock_redis):
        await publish_user_event(
            user_id=None,
            event_type="RESUME_STATUS",
            data={"resumeId": "res-1"},
        )

        mock_redis.publish.assert_not_called()


@pytest.mark.asyncio
async def test_publish_user_event_swallows_redis_errors():
    mock_redis = AsyncMock()
    mock_redis.publish.side_effect = ConnectionError("Redis down")

    with patch("ml.worker.get_redis_pub_client", return_value=mock_redis):
        # Should not raise exception
        await publish_user_event(
            user_id="user-fail-safe",
            event_type="MATCH_STATUS",
            data={"jobId": "j-1"},
        )


def test_get_user_id_for_resume_with_db_mock():
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = ("test-user-id-from-db",)
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.__enter__.return_value = mock_conn

    with patch("psycopg.connect", return_value=mock_conn):
        uid = get_user_id_for_resume("res-uuid-1")
        assert uid == "test-user-id-from-db"


def test_get_user_id_for_job_with_db_mock():
    mock_conn = MagicMock()
    mock_cur = MagicMock()
    mock_cur.fetchone.return_value = ("job-user-id-from-db",)
    mock_conn.cursor.return_value.__enter__.return_value = mock_cur
    mock_conn.__enter__.return_value = mock_conn

    with patch("psycopg.connect", return_value=mock_conn):
        uid = get_user_id_for_job("job-uuid-1")
        assert uid == "job-user-id-from-db"
