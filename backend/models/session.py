import uuid
from datetime import datetime, timezone
from sqlalchemy import Boolean, String, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column
from db.session import Base

class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    clerk_user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    label: Mapped[str | None] = mapped_column(String, nullable=True)
    sport: Mapped[str] = mapped_column(String, nullable=False, default="boxing")
    session_type: Mapped[str | None] = mapped_column(String, nullable=True)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    llm_summary: Mapped[str | None] = mapped_column(String, nullable=True)
    llm_summary_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    llm_summary_dirty: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    llm_summary_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    precomputed_summary_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
