import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, Boolean, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, ARRAY
from sqlalchemy.orm import Mapped, mapped_column
from db.session import Base


class CoachProfile(Base):
    __tablename__ = "coach_profiles"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    bio: Mapped[str | None] = mapped_column(String, nullable=True)
    specializations: Mapped[list[str]] = mapped_column(ARRAY(String), nullable=False, default=list)
    credit_rate: Mapped[int | None] = mapped_column(Integer, nullable=True)
    avg_response_hours: Mapped[float | None] = mapped_column(Float, nullable=True)
    rating: Mapped[float | None] = mapped_column(Float, nullable=True)
    review_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_featured: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    marketplace_visible: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    moderation_status: Mapped[str] = mapped_column(String, nullable=False, default="pending")  # pending | approved | rejected
    moderation_notes: Mapped[str | None] = mapped_column(String, nullable=True)
    review_preference: Mapped[str] = mapped_column(String, nullable=False, default="either")  # clip | session | either
    stripe_account_id: Mapped[str | None] = mapped_column(String, nullable=True)
    stripe_payouts_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    avatar_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    intro_video_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    intro_video_thumb_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
