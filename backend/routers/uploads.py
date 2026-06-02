import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from core.s3 import generate_presigned_upload_url
from dependencies import get_current_user
from worker.tasks import process_clip
from db.session import get_db
from models.clip import Clip
from models.job import Job
from models.session import Session

router = APIRouter(prefix="/uploads", tags=["uploads"])

ALLOWED_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo"}
MAX_DURATION_SECONDS = 300  # 5 minutes

# --- Request / Response schemas ---

class UploadInitRequest(BaseModel):
    filename: str
    content_type: str
    duration_seconds: int | None = None
    sport: str = "boxing"
    session_id: str | None = None


class UploadInitResponse(BaseModel):
    clip_id: str
    upload_url: str
    s3_key: str


class UploadCompleteRequest(BaseModel):
    clip_id: str


class UploadCompleteResponse(BaseModel):
    clip_id: str
    job_id: str


# --- Routes ---

@router.post("/init", response_model=UploadInitResponse, status_code=status.HTTP_201_CREATED)
async def upload_init(
    body: UploadInitRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 1 of 3 in the upload flow.
    Creates a clip row in the DB and returns a presigned S3 URL.
    The frontend uploads the video file directly to S3 using this URL.
    """
    if body.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type. Allowed: {', '.join(ALLOWED_CONTENT_TYPES)}",
        )

    if body.duration_seconds and body.duration_seconds > MAX_DURATION_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Clip exceeds maximum duration of {MAX_DURATION_SECONDS} seconds",
        )

    # Build a unique S3 key scoped to the user
    # raw/ prefix separates uploads from processed results
    s3_key = f"raw/{user_id}/{uuid.uuid4()}/{body.filename}"

    # Create the clip row — status starts as 'pending' until upload completes
    clip = Clip(
        clerk_user_id=user_id,
        s3_key=s3_key,
        filename=body.filename,
        duration_seconds=body.duration_seconds,
        status="pending",
        sport=body.sport,
        session_id=uuid.UUID(body.session_id) if body.session_id else None,
    )
    db.add(clip)
    await db.commit()
    await db.refresh(clip)

    # Clip added to a session — mark that session's LLM summary as stale
    if clip.session_id:
        session_result = await db.execute(select(Session).where(Session.id == clip.session_id))
        session = session_result.scalar_one_or_none()
        if session:
            session.llm_summary_dirty = True
            await db.commit()

    upload_url = generate_presigned_upload_url(s3_key, body.content_type)

    return UploadInitResponse(
        clip_id=str(clip.id),
        upload_url=upload_url,
        s3_key=s3_key,
    )


@router.post("/complete", response_model=UploadCompleteResponse)
async def upload_complete(
    body: UploadCompleteRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Step 3 of 3 in the upload flow (step 2 is the browser uploading to S3).
    Marks the clip as uploaded and enqueues the processing job.
    """
    # Fetch clip and verify it belongs to the requesting user
    result = await db.execute(
        select(Clip).where(
            Clip.id == body.clip_id,
            Clip.clerk_user_id == user_id,
        )
    )
    clip = result.scalar_one_or_none()

    if clip is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Clip not found",
        )

    if clip.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Clip upload already {clip.status}",
        )

    # Mark upload as complete
    clip.status = "uploaded"
    await db.commit()

    # Create the job row
    job = Job(clip_id=clip.id)
    db.add(job)
    await db.commit()
    await db.refresh(job)

    process_clip.delay(str(clip.id), str(job.id))

    return UploadCompleteResponse(
        clip_id=str(clip.id),
        job_id=str(job.id),
    )