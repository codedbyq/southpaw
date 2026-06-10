from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Clerk
    CLERK_SECRET_KEY: str = ""
    CLERK_AUTHORIZED_PARTIES: str = "http://localhost:5173"
    CLERK_FRONTEND_API: str = ""
    CLERK_WEBHOOK_SECRET: str = ""  # set in .env after creating webhook in Clerk dashboard

    # Database
    DATABASE_URL: str

    # AWS S3
    AWS_ACCESS_KEY_ID: str
    AWS_SECRET_ACCESS_KEY: str
    AWS_REGION: str = "us-east-1"
    S3_BUCKET_NAME: str

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"  # /0 is the Redis database index

    # LLM
    DEEPSEEK_API_KEY: str = ""

    # Modal — which deployed environment to call for inference.
    # Empty = Modal's default environment (prod). Set to "dev" locally.
    MODAL_ENVIRONMENT: str = ""

    # Stripe
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""
    STRIPE_PRO_PRICE_ID: str = ""
    STRIPE_ELITE_PRICE_ID: str = ""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def authorized_parties_list(self) -> list[str]:
        return [p.strip() for p in self.CLERK_AUTHORIZED_PARTIES.split(",")]


settings = Settings()
