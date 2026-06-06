import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, Boolean, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from db.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    user_type: Mapped[str | None] = mapped_column(String, nullable=True, default=None)  # null = onboarding not complete; athlete | coach
    subscription_tier: Mapped[str] = mapped_column(String, nullable=False, default="free")  # free | pro | elite
    credits_balance: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_admin: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    stripe_customer_id: Mapped[str | None] = mapped_column(String, nullable=True)
    experience_level: Mapped[str] = mapped_column(String, nullable=False, default="intermediate")
    # beginner | intermediate | advanced | pro
    trend_feedback: Mapped[str | None] = mapped_column(String, nullable=True)
    trend_feedback_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
