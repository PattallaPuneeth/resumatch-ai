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
        default="postgresql://resumatch_user:resumatch_password@localhost:5432/resumatch_db",
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


settings = Settings()
