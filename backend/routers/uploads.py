import uuid
from datetime import datetime, timezone, timedelta
from backend.models import user
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
import modal

from core.s3 import (
    generate_presigned_upload_url,
    create_multipart_upload,
    generate_presigned_part_url,
    complete_multipart_upload,
    abort_multipart_upload,
)
from dependencies import get_current_user
# from worker.tasks import process_clip
from db.session import get_db
from models.clip import Clip
from models.job import Job
from models.session import Session
from models.user import User

router = APIRouter(prefix="/uploads", tags=["uploads"])
_run_inference = None

def get_inference_function():
    global _run_inference
    if _run_inference is None:
        _run_inference = modal.Function.lookup("southpaw-inference", "run_inference")
    return _run_inference

ALLOWED_CONTENT_TYPES = {"video/mp4", "video/quicktime", "video/x-msvideo"}
MAX_DURATION_SECONDS = 300  # 5 minutes

# --- Request / Response schemas ---

class UploadInitRequest(BaseModel):
    filename: str
    content_type: str
    duration_seconds: int | None = None
    sport: str = "boxing"
    session_id: str | None = None
    notes: str | None = None


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

    # Enforce free tier clip limit (3 clips per month)
    user_result = await db.execute(select(User).where(User.clerk_user_id == user_id))
    user = user_result.scalar_one_or_none()
    if user and user.subscription_tier == "free":
        start_of_month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        clip_count_result = await db.execute(
            select(func.count(Clip.id)).where(
                Clip.clerk_user_id == user_id,
                Clip.created_at >= start_of_month,
            )
        )
        clip_count = clip_count_result.scalar() or 0
        if clip_count >= 3:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="Free tier limit reached — upgrade to Pro for unlimited clips",
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
        notes=body.notes,
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
    # Fetch clip + user in a single query
    result = await db.execute(
        select(Clip, User)
        .outerjoin(User, Clip.clerk_user_id == User.clerk_user_id)
        .where(Clip.id == body.clip_id, Clip.clerk_user_id == user_id)
    )
    row = result.one_or_none()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Clip not found",
        )

    clip, user = row
    tier = user.subscription_tier if user else "free"

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

    get_inference_function().spawn(
        clip_id=str(clip.id),
        job_id=str(job.id),
        s3_key=clip.s3_key,
        tier=tier,
    )

    return UploadCompleteResponse(
        clip_id=str(clip.id),
        job_id=str(job.id),
    )


# --- Multipart upload ---

MULTIPART_CHUNK_SIZE = 10 * 1024 * 1024  # 10MB


class MultipartInitRequest(BaseModel):
    filename: str
    content_type: str
    file_size: int            # bytes — used to compute part count
    duration_seconds: int | None = None
    sport: str = "boxing"
    session_id: str | None = None
    notes: str | None = None


class MultipartInitResponse(BaseModel):
    clip_id: str
    upload_id: str
    s3_key: str
    part_urls: list[dict]     # [{part_number, url}]


class MultipartPart(BaseModel):
    part_number: int
    etag: str


class MultipartCompleteRequest(BaseModel):
    clip_id: str
    upload_id: str
    s3_key: str
    parts: list[MultipartPart]  # collected ETags from each part upload


@router.post("/multipart/init", response_model=MultipartInitResponse, status_code=status.HTTP_201_CREATED)
async def multipart_init(
    body: MultipartInitRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Initiate a multipart S3 upload.
    Returns presigned URLs for each part — frontend uploads parts in parallel.
    """
    if body.content_type not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                            detail=f"Unsupported file type")

    if body.duration_seconds and body.duration_seconds > MAX_DURATION_SECONDS:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Clip exceeds maximum duration of {MAX_DURATION_SECONDS} seconds")

    # Free tier clip limit
    user_result = await db.execute(select(User).where(User.clerk_user_id == user_id))
    user = user_result.scalar_one_or_none()
    if user and user.subscription_tier == "free":
        start_of_month = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        clip_count_result = await db.execute(
            select(func.count(Clip.id)).where(
                Clip.clerk_user_id == user_id,
                Clip.created_at >= start_of_month,
            )
        )
        if (clip_count_result.scalar() or 0) >= 3:
            raise HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED,
                                detail="Free tier limit reached — upgrade to Pro for unlimited clips")

    s3_key = f"raw/{user_id}/{uuid.uuid4()}/{body.filename}"

    # Create clip row
    clip = Clip(
        clerk_user_id=user_id,
        s3_key=s3_key,
        filename=body.filename,
        duration_seconds=body.duration_seconds,
        status="pending",
        sport=body.sport,
        session_id=uuid.UUID(body.session_id) if body.session_id else None,
        notes=body.notes,
    )
    db.add(clip)
    await db.commit()
    await db.refresh(clip)

    if clip.session_id:
        session_result = await db.execute(select(Session).where(Session.id == clip.session_id))
        session = session_result.scalar_one_or_none()
        if session:
            session.llm_summary_dirty = True
            await db.commit()

    # Create multipart upload on S3
    upload_id = create_multipart_upload(s3_key, body.content_type)

    # Generate presigned URL for each part
    import math
    part_count = max(1, math.ceil(body.file_size / MULTIPART_CHUNK_SIZE))
    part_urls = [
        {"part_number": i + 1, "url": generate_presigned_part_url(s3_key, upload_id, i + 1)}
        for i in range(part_count)
    ]

    return MultipartInitResponse(
        clip_id=str(clip.id),
        upload_id=upload_id,
        s3_key=s3_key,
        part_urls=part_urls,
    )


@router.post("/multipart/complete", response_model=UploadCompleteResponse)
async def multipart_complete(
    body: MultipartCompleteRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Finalize the multipart upload, mark clip as uploaded, enqueue processing.
    """
    # Fetch clip + user in a single query
    result = await db.execute(
        select(Clip, User)
        .outerjoin(User, Clip.clerk_user_id == User.clerk_user_id)
        .where(Clip.id == body.clip_id, Clip.clerk_user_id == user_id)
    )
    row = result.one_or_none()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found")

    clip, user = row
    tier = user.subscription_tier if user else "free"

    if clip.status != "pending":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"Clip upload already {clip.status}")

    # Complete the multipart upload on S3
    try:
        complete_multipart_upload(
            body.s3_key,
            body.upload_id,
            [{"PartNumber": p.part_number, "ETag": p.etag} for p in body.parts],
        )
    except Exception as e:
        abort_multipart_upload(body.s3_key, body.upload_id)
        raise HTTPException(status_code=500, detail=f"Failed to complete upload: {e}")

    clip.status = "uploaded"
    await db.commit()

    job = Job(clip_id=clip.id)
    db.add(job)
    await db.commit()
    await db.refresh(job)

    get_inference_function().spawn(
        clip_id=str(clip.id),
        job_id=str(job.id),
        s3_key=clip.s3_key,
        tier=tier,
    )

    return UploadCompleteResponse(clip_id=str(clip.id), job_id=str(job.id))