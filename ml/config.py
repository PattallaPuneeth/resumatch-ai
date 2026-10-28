from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "ResuMatch AI - ML Service"
    env: str = Field(default="development", alias="ENV")
    host: str = Field(default="0.0.0.0", alias="HOST")
    port: int = Field(default=8000, alias="PORT")
    log_level: str = Field(default="info", alias="LOG_LEVEL")

    internal_api_token: str = Field(
        default="",
        alias="INTERNAL_API_TOKEN",
        description="Shared secret token for Node <-> ML internal authentication (min 32 chars)",
    )

    @field_validator("internal_api_token")
    @classmethod
    def validate_internal_api_token(cls, v: str) -> str:
        if v:
            if len(v.strip()) < 32:
                raise ValueError("INTERNAL_API_TOKEN must be at least 32 characters long")
            if "change_me" in v.lower():
                raise ValueError("INTERNAL_API_TOKEN cannot contain CHANGE_ME placeholder")
        return v

    database_url: str = Field(
        default="postgresql://resumatch_user:resumatch_password@localhost:5432/resumatch",
        alias="DATABASE_URL",
    )

    redis_url: str = Field(
        default="redis://localhost:6379",
        alias="REDIS_URL",
    )

    embedding_dimension: int = Field(
        default=384,
        alias="EMBEDDING_DIMENSION",
    )
    embedding_model_name: str = Field(
        default="sentence-transformers/all-MiniLM-L6-v2",
        alias="EMBEDDING_MODEL_NAME",
    )
    reranker_model_name: str = Field(
        default="cross-encoder/ms-marco-MiniLM-L-6-v2",
        alias="RERANKER_MODEL_NAME",
    )
    rrf_k: int = Field(
        default=60,
        alias="RRF_K",
    )
    top_k_candidates: int = Field(
        default=20,
        alias="TOP_K_CANDIDATES",
    )
    # Weight of a preferred skill relative to a required one in skill coverage (0 to 1)
    preferred_skill_weight: float = Field(
        default=0.5,
        ge=0.0,
        le=1.0,
        alias="PREFERRED_SKILL_WEIGHT",
    )

    # S3 Object Storage Configuration
    s3_endpoint: str = Field(default="http://localhost:9000", alias="S3_ENDPOINT")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    s3_bucket: str = Field(default="resumes", alias="S3_BUCKET")
    s3_access_key: str = Field(default="minioadmin", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="minioadmin", alias="S3_SECRET_KEY")

    # Document Parsing & OCR Configuration (Phase 2C)
    ocr_dpi: int = Field(default=300, alias="OCR_DPI")
    # When true, parse jobs that need OCR move to resume-ocr-queue, served by a separate
    # worker process, so text PDFs don't wait behind 6-7 s scans (docs/PERFORMANCE.md).
    ocr_queue_enabled: bool = Field(default=False, alias="OCR_QUEUE_ENABLED")
    # Queues this worker process serves: "all", or a comma list of parse, ocr, embed, match,
    # analysis. The default keeps one process serving everything.
    worker_queues: str = Field(default="all", alias="WORKER_QUEUES")
    # Intra-op threads per torch inference call; 0 keeps torch's default. Several inference
    # calls can run at once in one worker, so a cap avoids oversubscribing the CPUs.
    torch_num_threads: int = Field(default=0, ge=0, le=64, alias="TORCH_NUM_THREADS")
    ocr_max_pages: int = Field(default=5, alias="OCR_MAX_PAGES")
    ocr_min_chars: int = Field(default=200, alias="OCR_MIN_CHARS")
    ocr_alphanumeric_threshold: float = Field(default=0.50, alias="OCR_ALPHANUMERIC_THRESHOLD")
    max_resume_pages: int = Field(default=20, alias="MAX_RESUME_PAGES")


settings = Settings()
