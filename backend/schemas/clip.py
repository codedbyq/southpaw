import uuid
from datetime import datetime

from pydantic import BaseModel


class ClipBase(BaseModel):
    filename: str
    duration_seconds: int | None = None


class ClipCreate(ClipBase):
    pass


class ClipResponse(ClipBase):
    id: uuid.UUID
    s3_key: str | None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
