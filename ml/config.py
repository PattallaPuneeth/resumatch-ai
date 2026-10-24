from pydantic import Field
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
        default="resumatch-ml-secret-key-phase1",
        alias="INTERNAL_API_TOKEN",
        description="Shared secret token for Node <-> ML internal authentication",
    )

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

    # S3 Object Storage Configuration
    s3_endpoint: str = Field(default="http://localhost:9000", alias="S3_ENDPOINT")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    s3_bucket: str = Field(default="resumes", alias="S3_BUCKET")
    s3_access_key: str = Field(default="minioadmin", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="minioadmin", alias="S3_SECRET_KEY")

    # Document Parsing & OCR Configuration (Phase 2C)
    ocr_dpi: int = Field(default=300, alias="OCR_DPI")
    ocr_max_pages: int = Field(default=5, alias="OCR_MAX_PAGES")
    ocr_min_chars: int = Field(default=200, alias="OCR_MIN_CHARS")
    ocr_alphanumeric_threshold: float = Field(default=0.50, alias="OCR_ALPHANUMERIC_THRESHOLD")
    max_resume_pages: int = Field(default=20, alias="MAX_RESUME_PAGES")


settings = Settings()
