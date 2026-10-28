"""A match whose resume or job was deleted while queued is skipped, not retried as an error."""

from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

import psycopg
import pytest

from ml.pipelines.matching.repository import MatchTargetGoneError, persist_match_result
from ml.worker import process_match_scoring


def test_persist_raises_target_gone_on_foreign_key_violation() -> None:
    conn = MagicMock()
    conn.__enter__.return_value = conn
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.execute.side_effect = psycopg.errors.ForeignKeyViolation("matches_resumeId_fkey")

    with patch("ml.pipelines.matching.repository.psycopg.connect", return_value=conn):
        with pytest.raises(MatchTargetGoneError):
            persist_match_result(resume_id="r-gone", job_id="j-1", final_score=50.0)


@pytest.mark.asyncio
async def test_worker_skips_quietly_when_target_is_gone(caplog: pytest.LogCaptureFixture) -> None:
    job = MagicMock()
    job.id = "job-test-gone"
    job.data = {"jobId": "j-1", "resumeId": "r-gone"}
    ctx = {"resume_status": "PARSED", "job_title": "Backend Engineer",
           "job_description": "Python and PostgreSQL", "resume_raw_text": "Python developer"}

    with patch("ml.worker.get_match_context", return_value=ctx), patch(
        "ml.worker.search_lexical", side_effect=MatchTargetGoneError("resume r-gone no longer exists")
    ):
        with caplog.at_level(logging.WARNING):
            result = await process_match_scoring(job)

    assert result["status"] == "SKIPPED" and result["reason"] == "target_deleted"
    assert not any(r.levelno >= logging.ERROR for r in caplog.records)
