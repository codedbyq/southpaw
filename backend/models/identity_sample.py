import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from db.base import Base


class IdentitySample(Base):
    """A labeled 'this tracked subject is this athlete' observation.

    Sources: 'solo' (single-person clip — free high-confidence label),
    'manual' (user picked the subject in the player), 'auto' (future ReID).
    Written only when the user has biometric consent on file; one canonical
    sample per clip. skeletal_stats are torso-normalized limb ratios, so the
    selection can be re-matched after a model/tracker upgrade (the raw
    tracker_id alone is arbitrary per pipeline run).
    """
    __tablename__ = "identity_samples"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False, index=True)
    clip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("clips.id", ondelete="CASCADE"), nullable=False, unique=True)
    subject_id: Mapped[int] = mapped_column(Integer, nullable=False)
    pipeline_version: Mapped[str | None] = mapped_column(String, nullable=True)
    source: Mapped[str] = mapped_column(String, nullable=False)  # solo | manual | auto
    skeletal_stats: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    embedding: Mapped[list | None] = mapped_column(JSONB, nullable=True)  # normalized OSNet centroid (athlete only)
    embedding_model: Mapped[str | None] = mapped_column(String, nullable=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # bad-label recovery
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
