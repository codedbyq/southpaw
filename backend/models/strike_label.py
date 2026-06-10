import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Float, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from db.base import Base


class StrikeLabel(Base):
    """Ground-truth feedback on strike detections — the training-data flywheel
    for the future ML classifier. strike_id is null for 'missed' labels (a
    strike the system didn't detect, added by the user on the timeline)."""
    __tablename__ = "strike_labels"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("clips.id", ondelete="CASCADE"), nullable=False, index=True)
    strike_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("strikes.id", ondelete="SET NULL"), nullable=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    label: Mapped[str] = mapped_column(String, nullable=False)  # correct | wrong_type | not_a_strike | missed
    corrected_type: Mapped[str | None] = mapped_column(String, nullable=True)
    timestamp_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    source: Mapped[str] = mapped_column(String, nullable=False, default="athlete")  # athlete | coach_comment | admin
    window_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)  # ±1s keypoint window for self-contained training examples
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
