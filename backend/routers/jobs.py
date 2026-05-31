import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from dependencies import get_current_user

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}")
async def get_job(job_id: uuid.UUID, clerk_user_id: str = Depends(get_current_user)):
    # TODO: return job status + progress
    pass


@router.get("/{job_id}/stream")
async def stream_job(job_id: uuid.UUID, clerk_user_id: str = Depends(get_current_user)):
    # TODO: SSE stream — forward Redis pub/sub events to client
    return StreamingResponse(None, media_type="text/event-stream")
