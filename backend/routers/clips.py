import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from datetime import datetime

from dependencies import get_current_user
from db.session import get_db
from models.clip import Clip
from models.job import Job
from core.s3 import generate_presigned_download_url

router = APIRouter(prefix="/clips", tags=["clips"])


# --- Response schemas ---

class JobSummary(BaseModel):
    id: str
    status: str
    progress: int

    class Config:
        from_attributes = True


class ClipResponse(BaseModel):
    id: str
    filename: str
    duration_seconds: int | None
    status: str
    created_at: datetime
    job: JobSummary | None
    result_url: str | None  # presigned S3 URL for the keypoint JSON

    class Config:
        from_attributes = True


# --- Routes ---

@router.get("", response_model=list[ClipResponse])
async def list_clips(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all clips for the authenticated user, newest first."""
    result = await db.execute(
        select(Clip)
        .where(Clip.clerk_user_id == clerk_user_id)
        .order_by(Clip.created_at.desc())
    )
    clips = result.scalars().all()

    return [await _build_clip_response(clip, db) for clip in clips]


@router.get("/{clip_id}", response_model=ClipResponse)
async def get_clip(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return a single clip with job status and result URL if processed."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)
    return await _build_clip_response(clip, db)


@router.delete("/{clip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_clip(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete clip from S3 and DB. Cascades to job and strikes."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)

    # Delete raw video from S3
    from core.s3 import s3_client
    from core.config import settings
    try:
        s3_client.delete_object(Bucket=settings.S3_BUCKET_NAME, Key=clip.s3_key)
    except Exception:
        pass  # Don't block DB delete if S3 delete fails

    # Delete processed JSON from S3 if it exists
    job_result = await db.execute(select(Job).where(Job.clip_id == clip.id))
    job = job_result.scalar_one_or_none()
    if job and job.result_s3_key:
        try:
            s3_client.delete_object(
                Bucket=settings.S3_BUCKET_NAME, Key=job.result_s3_key
            )
        except Exception:
            pass

    # Delete from DB — cascades to jobs and strikes
    await db.delete(clip)
    await db.commit()


# --- Helpers ---

async def _get_clip_for_user(
    clip_id: uuid.UUID,
    clerk_user_id: str,
    db: AsyncSession,
) -> Clip:
    result = await db.execute(
        select(Clip).where(
            Clip.id == clip_id,
            Clip.clerk_user_id == clerk_user_id,
        )
    )
    clip = result.scalar_one_or_none()
    if clip is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Clip not found"
        )
    return clip


async def _build_clip_response(clip: Clip, db: AsyncSession) -> ClipResponse:
    """Build a ClipResponse including job status and presigned result URL."""
    job_result = await db.execute(select(Job).where(Job.clip_id == clip.id))
    job = job_result.scalar_one_or_none()

    result_url = None
    if job and job.result_s3_key:
        result_url = generate_presigned_download_url(job.result_s3_key)

    return ClipResponse(
        id=str(clip.id),
        filename=clip.filename,
        duration_seconds=clip.duration_seconds,
        status=clip.status,
        created_at=clip.created_at,
        job=JobSummary(
            id=str(job.id),
            status=job.status,
            progress=job.progress,
        ) if job else None,
        result_url=result_url,
    )