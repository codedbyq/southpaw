import uuid

from pydantic import BaseModel


class StrikeResponse(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    type: str
    timestamp_seconds: float
    frame_index: int
    confidence: float | None

    model_config = {"from_attributes": True}
