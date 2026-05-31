from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Clerk
    CLERK_SECRET_KEY: str
    CLERK_AUTHORIZED_PARTIES: str = "http://localhost:5173"

    # Database
    DATABASE_URL: str

    # AWS S3
    AWS_ACCESS_KEY_ID: str
    AWS_SECRET_ACCESS_KEY: str
    AWS_REGION: str = "us-east-1"
    S3_BUCKET_NAME: str

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"  # /0 is the Redis database index

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def authorized_parties_list(self) -> list[str]:
        return [p.strip() for p in self.CLERK_AUTHORIZED_PARTIES.split(",")]


settings = Settings()
