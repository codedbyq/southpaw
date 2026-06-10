import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from db.base import Base

class Clip(Base):
    __tablename__ = "clips"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    s3_key: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending")
    sport: Mapped[str] = mapped_column(String, nullable=False, default="boxing")
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True
    )
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    stance: Mapped[str | None] = mapped_column(String, nullable=True)  # orthodox | southpaw | unknown
    head_movement_score: Mapped[float | None] = mapped_column(nullable=True)  # 0-1, higher = more active head movement
    selected_subject_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # ByteTrack id whose metrics are shown; null = single/none
    subject_confidence: Mapped[float | None] = mapped_column(nullable=True)  # 0-1 margin of primary-subject pick over runner-up
    pose_quality_score: Mapped[float | None] = mapped_column(nullable=True)  # 0-1 footage quality (brightness/size/conf/continuity/clarity)
    pipeline_version: Mapped[str | None] = mapped_column(String, nullable=True)  # e.g. 'v3:yolo11s-pose.pt:rules-2'; null = pre-versioning
    clip_type: Mapped[str | None] = mapped_column(String, nullable=True)  # bag | sparring | shadow | pads | strength
    feedback: Mapped[str | None] = mapped_column(String, nullable=True)
    thumbnail_s3_key: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )