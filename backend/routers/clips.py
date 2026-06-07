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
from models.session import Session
from models.user import User
from models.coach_profile import CoachProfile
from models.clip_comment import ClipComment
from models.clip_review import ClipReview
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
    sport: str
    notes: str | None
    head_movement_score: float | None
    session_id: str | None
    feedback: str | None
    created_at: datetime
    job: JobSummary | None
    result_url: str | None      # presigned URL for keypoint JSON
    video_url: str | None       # presigned URL for raw video
    thumbnail_url: str | None   # presigned URL for thumbnail image

    class Config:
        from_attributes = True


class ClipUpdateRequest(BaseModel):
    filename: str | None = None
    notes: str | None = None
    session_id: str | None = None  # uuid string to move to session, empty string to unorganize

# --- Routes ---

@router.get("", response_model=list[ClipResponse])
async def list_clips(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 20,
    offset: int = 0,
):
    """Return clips for the authenticated user, newest first. Paginated."""
    result = await db.execute(
        select(Clip)
        .where(Clip.clerk_user_id == clerk_user_id)
        .order_by(Clip.created_at.desc())
        .limit(limit)
        .offset(offset)
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


@router.get("/{clip_id}/feedback")
async def get_clip_feedback(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return pre-generated coaching feedback for a clip (written by the Modal inference function)."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)
    if not clip.feedback:
        raise HTTPException(status_code=404, detail="Feedback not yet available")
    return {"feedback": clip.feedback}


@router.delete("/{clip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_clip(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete clip from S3 and DB. Cascades to job and strikes."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)

    # Mark the parent session dirty before removing this clip
    if clip.session_id:
        session_result = await db.execute(select(Session).where(Session.id == clip.session_id))
        session = session_result.scalar_one_or_none()
        if session:
            session.llm_summary_dirty = True
            await db.commit()

    # Delete raw video and thumbnail from S3
    from core.s3 import s3_client
    from core.config import settings
    for key in filter(None, [clip.s3_key, clip.thumbnail_s3_key]):
        try:
            s3_client.delete_object(Bucket=settings.S3_BUCKET_NAME, Key=key)
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


# --- Comment schemas ---

class CommentResponse(BaseModel):
    id: str
    clip_id: str
    user_id: str
    author_name: str
    timestamp_seconds: float | None
    body: str
    is_own: bool
    created_at: datetime

    class Config:
        from_attributes = True


class CommentCreateRequest(BaseModel):
    body: str
    timestamp_seconds: float | None = None


# --- Comment routes ---

@router.get("/{clip_id}/comments", response_model=list[CommentResponse])
async def list_comments(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all comments for a clip, ordered by timestamp then created_at."""
    clip = await _get_clip_with_review_access(clip_id, clerk_user_id, db)

    result = await db.execute(
        select(ClipComment)
        .where(ClipComment.clip_id == clip.id)
        .order_by(
            ClipComment.timestamp_seconds.asc().nulls_last(),
            ClipComment.created_at.asc(),
        )
    )
    comments = result.scalars().all()

    # Resolve current user's DB id for is_own flag
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    current_user = user_result.scalar_one_or_none()
    current_user_id = current_user.id if current_user else None

    return [
        CommentResponse(
            id=str(c.id),
            clip_id=str(c.clip_id),
            user_id=str(c.user_id),
            author_name=c.author_name,
            timestamp_seconds=c.timestamp_seconds,
            body=c.body,
            is_own=current_user_id is not None and c.user_id == current_user_id,
            created_at=c.created_at,
        )
        for c in comments
    ]


@router.post("/{clip_id}/comments", response_model=CommentResponse, status_code=status.HTTP_201_CREATED)
async def create_comment(
    clip_id: uuid.UUID,
    body: CommentCreateRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Add a comment to a clip."""
    clip = await _get_clip_with_review_access(clip_id, clerk_user_id, db)

    # Resolve user
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Resolve display name — coach profile name if available, else "Athlete"
    author_name = "Athlete"
    if user.user_type == "coach":
        profile_result = await db.execute(
            select(CoachProfile).where(CoachProfile.user_id == user.id)
        )
        profile = profile_result.scalar_one_or_none()
        if profile and profile.display_name:
            author_name = profile.display_name

    comment = ClipComment(
        clip_id=clip.id,
        user_id=user.id,
        author_name=author_name,
        timestamp_seconds=body.timestamp_seconds,
        body=body.body.strip(),
    )
    db.add(comment)
    await db.commit()
    await db.refresh(comment)

    return CommentResponse(
        id=str(comment.id),
        clip_id=str(comment.clip_id),
        user_id=str(comment.user_id),
        author_name=comment.author_name,
        timestamp_seconds=comment.timestamp_seconds,
        body=comment.body,
        is_own=True,
        created_at=comment.created_at,
    )


@router.delete("/{clip_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    clip_id: uuid.UUID,
    comment_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete own comment."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    result = await db.execute(
        select(ClipComment).where(
            ClipComment.id == comment_id,
            ClipComment.clip_id == clip_id,
            ClipComment.user_id == user.id,
        )
    )
    comment = result.scalar_one_or_none()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    await db.delete(comment)
    await db.commit()


@router.patch("/{clip_id}", response_model=ClipResponse)
async def update_clip(
    clip_id: uuid.UUID,
    body: ClipUpdateRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update clip filename and/or notes."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)

    if body.filename is not None:
        clip.filename = body.filename.strip()
    if body.notes is not None:
        clip.notes = body.notes.strip() or None

    if body.session_id is not None:
        old_session_id = clip.session_id

        # Resolve new session — empty string means unorganize
        if body.session_id == "":
            clip.session_id = None
        else:
            new_session_result = await db.execute(
                select(Session).where(
                    Session.id == uuid.UUID(body.session_id),
                    Session.clerk_user_id == clerk_user_id,
                )
            )
            new_session = new_session_result.scalar_one_or_none()
            if not new_session:
                raise HTTPException(status_code=404, detail="Session not found")
            clip.session_id = new_session.id

        # Mark both old and new sessions dirty
        for sid in filter(None, [old_session_id, clip.session_id]):
            s_result = await db.execute(select(Session).where(Session.id == sid))
            s = s_result.scalar_one_or_none()
            if s:
                s.llm_summary_dirty = True

    await db.commit()
    return await _build_clip_response(clip, db)


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


async def _get_clip_with_review_access(
    clip_id: uuid.UUID,
    clerk_user_id: str,
    db: AsyncSession,
) -> Clip:
    """
    Returns a clip if the requester is the owner OR has an active review for it.
    Used for comment routes so coaches can comment on clips they're reviewing.
    """
    clip_result = await db.execute(select(Clip).where(Clip.id == clip_id))
    clip = clip_result.scalar_one_or_none()
    if clip is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found")

    # Owner always has access
    if clip.clerk_user_id == clerk_user_id:
        return clip

    # Check for an active clip_review linking this coach to this clip
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if user:
        review_result = await db.execute(
            select(ClipReview).where(
                ClipReview.clip_id == clip_id,
                ClipReview.coach_id == user.id,
                ClipReview.status.in_(["pending", "in_review", "complete"]),
            )
        )
        if review_result.scalar_one_or_none():
            return clip

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")


async def _build_clip_response(clip: Clip, db: AsyncSession) -> ClipResponse:
    """Build a ClipResponse including job status and presigned result URL."""
    job_result = await db.execute(select(Job).where(Job.clip_id == clip.id))
    job = job_result.scalar_one_or_none()

    result_url = None
    video_url = generate_presigned_download_url(clip.s3_key)
    thumbnail_url = None

    if job and job.result_s3_key:
        result_url = generate_presigned_download_url(job.result_s3_key)

    if clip.thumbnail_s3_key:
        thumbnail_url = generate_presigned_download_url(clip.thumbnail_s3_key)

    return ClipResponse(
        id=str(clip.id),
        filename=clip.filename,
        duration_seconds=clip.duration_seconds,
        status=clip.status,
        sport=clip.sport,
        notes=clip.notes,
        head_movement_score=clip.head_movement_score,
        session_id=str(clip.session_id) if clip.session_id else None,
        feedback=clip.feedback,
        created_at=clip.created_at,
        job=JobSummary(
            id=str(job.id),
            status=job.status,
            progress=job.progress,
        ) if job else None,
        result_url=result_url,
        video_url=video_url,
        thumbnail_url=thumbnail_url,
    )