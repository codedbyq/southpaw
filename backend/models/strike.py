import uuid
from sqlalchemy import String, Float, Integer, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship
from db.session import Base

class Strike(Base):
    __tablename__ = "strikes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False)
    type: Mapped[str] = mapped_column(String, nullable=False)
    timestamp_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    arm_extension: Mapped[float | None] = mapped_column(Float, nullable=True)
    guard_dropped: Mapped[bool | None] = mapped_column(nullable=True)
    peak_velocity: Mapped[float | None] = mapped_column(Float, nullable=True)
    recovery_seconds: Mapped[float | None] = mapped_column(Float, nullable=True)
    hip_rotation: Mapped[float | None] = mapped_column(Float, nullable=True)  # shoulder-hip angle delta during strike

    job: Mapped["Job"] = relationship("Job", back_populates="strikes")