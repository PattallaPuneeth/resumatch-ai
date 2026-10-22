from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

from ml.config import settings
from ml.storage.s3 import (
    check_s3_health,
    download_file,
    get_object_bytes,
    get_s3_client,
    head_object,
)


def test_s3_settings_configured() -> None:
    assert settings.s3_endpoint is not None
    assert settings.s3_bucket == "resumes"
    assert settings.s3_region == "us-east-1"


def test_get_s3_client_initialization() -> None:
    client = get_s3_client()
    assert client is not None


def test_head_object_existing() -> None:
    mock_client = MagicMock()
    mock_client.head_object.return_value = {
        "ContentLength": 1024,
        "ContentType": "application/pdf",
        "ETag": '"test-etag"',
    }
    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        result = head_object("resumes/user/resume.pdf")
        assert result is not None
        assert result["content_length"] == 1024
        assert result["content_type"] == "application/pdf"
        assert result["etag"] == '"test-etag"'


def test_head_object_not_found() -> None:
    mock_client = MagicMock()
    mock_client.head_object.side_effect = ClientError(
        {"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject"
    )
    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        result = head_object("resumes/user/nonexistent.pdf")
        assert result is None


def test_get_object_bytes() -> None:
    mock_client = MagicMock()
    mock_body = MagicMock()
    mock_body.read.return_value = b"%PDF-1.4 sample content"
    mock_client.get_object.return_value = {"Body": mock_body}

    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        data = get_object_bytes("resumes/user/resume.pdf")
        assert data == b"%PDF-1.4 sample content"


def test_download_file() -> None:
    mock_client = MagicMock()
    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        download_file("resumes/user/resume.pdf", "/tmp/local.pdf")
        mock_client.download_file.assert_called_once_with(
            "resumes", "resumes/user/resume.pdf", "/tmp/local.pdf"
        )


def test_check_s3_health_healthy() -> None:
    mock_client = MagicMock()
    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        result = check_s3_health()
        assert result["status"] == "healthy"
        assert "latency_ms" in result


def test_check_s3_health_unhealthy() -> None:
    mock_client = MagicMock()
    mock_client.head_bucket.side_effect = Exception("Bucket not found")
    with patch("ml.storage.s3.get_s3_client", return_value=mock_client):
        result = check_s3_health()
        assert result["status"] == "unhealthy"
        assert "error" in result
