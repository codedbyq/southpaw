import uuid
from datetime import datetime

from pydantic import BaseModel


class JobResponse(BaseModel):
    id: uuid.UUID
    clip_id: uuid.UUID
    status: str
    progress: int
    result_s3_key: str | None
    error: str | None
    started_at: datetime | None
    completed_at: datetime | None

    model_config = {"from_attributes": True}
