import time
from typing import Any

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from ml.config import settings


def get_s3_client() -> Any:
    """Create and return a configured boto3 S3 client."""
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        region_name=settings.s3_region,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


def download_file(storage_key: str, local_path: str, bucket: str | None = None) -> None:
    """Download an S3 object to local disk (e.g. /tmp)."""
    target_bucket = bucket or settings.s3_bucket
    client = get_s3_client()
    client.download_file(target_bucket, storage_key, local_path)


def get_object_bytes(storage_key: str, bucket: str | None = None) -> bytes:
    """Fetch raw bytes of an S3 object."""
    target_bucket = bucket or settings.s3_bucket
    client = get_s3_client()
    response = client.get_object(Bucket=target_bucket, Key=storage_key)
    body_bytes: bytes = response["Body"].read()
    return body_bytes


def head_object(storage_key: str, bucket: str | None = None) -> dict[str, Any] | None:
    """Check existence and metadata of an S3 object."""
    target_bucket = bucket or settings.s3_bucket
    client = get_s3_client()
    try:
        response = client.head_object(Bucket=target_bucket, Key=storage_key)
        return {
            "content_length": response.get("ContentLength", 0),
            "content_type": response.get("ContentType"),
            "etag": response.get("ETag"),
        }
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
            return None
        raise e


def check_s3_health(bucket: str | None = None) -> dict[str, Any]:
    """Check connection and bucket existence for health endpoints."""
    target_bucket = bucket or settings.s3_bucket
    start = time.perf_counter()
    try:
        client = get_s3_client()
        client.head_bucket(Bucket=target_bucket)
        latency_ms = round((time.perf_counter() - start) * 1000, 2)
        return {"status": "healthy", "latency_ms": latency_ms}
    except Exception as e:
        latency_ms = round((time.perf_counter() - start) * 1000, 2)
        return {
            "status": "unhealthy",
            "latency_ms": latency_ms,
            "error": str(e),
        }
