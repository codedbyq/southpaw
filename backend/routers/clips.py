import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, delete
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
    error: str | None = None
    error_code: str | None = None

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
    selected_subject_id: int | None = None
    subject_confidence: float | None = None
    pose_quality_score: float | None = None
    pipeline_version: str | None = None
    clip_type: str | None = None
    session_id: str | None
    feedback: str | None
    created_at: datetime
    job: JobSummary | None
    result_url: str | None      # presigned URL for keypoint JSON
    video_url: str | None       # presigned URL for raw video
    thumbnail_url: str | None   # presigned URL for thumbnail image

    class Config:
        from_attributes = True


VALID_CLIP_TYPES = {"bag", "sparring", "shadow", "pads", "strength"}


class ClipUpdateRequest(BaseModel):
    filename: str | None = None
    notes: str | None = None
    session_id: str | None = None  # uuid string to move to session, empty string to unorganize
    clip_type: str | None = None   # corrects the type inherited from the session at upload

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


class SelectSubjectRequest(BaseModel):
    subject_id: int


@router.post("/{clip_id}/select-subject", response_model=ClipResponse)
async def select_subject(
    clip_id: uuid.UUID,
    body: SelectSubjectRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Switch which tracked subject's metrics/feedback this clip shows.
    Re-derives strikes from the stored keypoints JSON — no re-running YOLO."""
    import json
    from core.s3 import s3_client
    from core.config import settings
    from models.strike import Strike
    from services.clip_metrics import (
        strikes_for_subject, apply_recovery_seconds, compute_head_movement, detect_stance,
    )
    from services.feedback import build_clip_summary, generate_feedback

    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)
    job = (await db.execute(select(Job).where(Job.clip_id == clip.id))).scalar_one_or_none()
    if job is None or not job.result_s3_key:
        raise HTTPException(status_code=400, detail="Clip has no processed keypoint data")

    try:
        obj = s3_client.get_object(Bucket=settings.S3_BUCKET_NAME, Key=job.result_s3_key)
        data = json.loads(obj["Body"].read())
    except Exception:
        raise HTTPException(status_code=502, detail="Could not load keypoint data")
    frames = data.get("frames", [])

    subject_id = body.subject_id
    subject_strikes = strikes_for_subject(frames, subject_id)
    apply_recovery_seconds(subject_strikes)

    # Swap this clip's strike rows for the chosen subject's. Low-confidence
    # strikes stay in the JSON but out of metrics — same rule as the pipeline.
    await db.execute(delete(Strike).where(Strike.job_id == job.id))
    new_rows = []
    for s in subject_strikes:
        if s.get("low_confidence"):
            continue
        row = Strike(
            job_id=job.id,
            type=s["type"],
            timestamp_seconds=s["timestamp_seconds"],
            frame_index=s["frame_index"],
            subject_id=s.get("subject_id", subject_id),
            confidence=s.get("confidence"),
            arm_extension=s.get("arm_extension"),
            guard_dropped=s.get("guard_dropped"),
            peak_velocity=s.get("peak_velocity"),
            recovery_seconds=s.get("recovery_seconds"),
            hip_rotation=s.get("hip_rotation"),
        )
        db.add(row)
        new_rows.append(row)

    # Recompute subject-scoped clip metrics
    head = compute_head_movement(frames, subject_id)
    if head is not None:
        clip.head_movement_score = head
    clip.stance = detect_stance(frames, subject_id)
    clip.selected_subject_id = subject_id
    await db.flush()

    user = (await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))).scalar_one_or_none()

    # A manual pick is a labeled identity sample ("this subject = me") — the
    # selector doubles as the ReID labeling UI. Consent-gated (BIPA et al.).
    if user is not None and user.biometric_consent_at is not None:
        from models.identity_sample import IdentitySample
        from services.clip_metrics import skeletal_stats

        await db.execute(delete(IdentitySample).where(IdentitySample.clip_id == clip.id))
        db.add(IdentitySample(
            user_id=user.id,
            clip_id=clip.id,
            subject_id=subject_id,
            pipeline_version=clip.pipeline_version,
            source="manual",
            skeletal_stats=skeletal_stats(frames, subject_id),
            confidence=1.0,  # user-confirmed
        ))
        await db.flush()

    # Regenerate clip feedback for the new subject
    try:
        summary = build_clip_summary(clip, new_rows, user=user)
        llm_model = "deepseek-reasoner" if (user and user.subscription_tier == "elite") else "deepseek-chat"
        clip.feedback = await generate_feedback(summary, llm_model=llm_model)
    except Exception:
        clip.feedback = None

    # Mark parent session dirty so its cached feedback regenerates
    if clip.session_id:
        session_obj = (await db.execute(select(Session).where(Session.id == clip.session_id))).scalar_one_or_none()
        if session_obj:
            session_obj.llm_summary_dirty = True

    await db.commit()
    return await _build_clip_response(clip, db)


@router.post("/{clip_id}/retry", response_model=ClipResponse)
async def retry_clip(
    clip_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Re-run processing for a failed clip. Safe to call repeatedly —
    run_inference is idempotent (wipes its own strike rows at start)."""
    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)
    job = (await db.execute(select(Job).where(Job.clip_id == clip.id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status_code=400, detail="Clip has no processing job")
    if job.status != "failed":
        raise HTTPException(status_code=409, detail=f"Job is {job.status} — only failed jobs can be retried")

    job.status = "queued"
    job.progress = 0
    job.error = None
    job.error_code = None
    await db.commit()

    user = (await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))).scalar_one_or_none()
    tier = user.subscription_tier if user else "free"

    from routers.uploads import get_inference_function
    await get_inference_function().spawn.aio(
        clip_id=str(clip.id),
        job_id=str(job.id),
        s3_key=clip.s3_key,
        tier=tier,
    )
    return await _build_clip_response(clip, db)


class StrikeLabelRequest(BaseModel):
    strike_id: str | None = None      # null for 'missed' labels
    label: str                        # correct | wrong_type | not_a_strike | missed
    corrected_type: str | None = None
    timestamp_seconds: float | None = None


VALID_STRIKE_LABELS = {"correct", "wrong_type", "not_a_strike", "missed"}
# Ground-truth labels use the axis taxonomy for kicks (lead/rear), matching how
# jab/cross encodes axis for punches. "roundhouse_kick" stays valid only for
# backwards compatibility with the classifier's current naming — golden_eval
# normalizes it to rear_kick when scoring.
VALID_STRIKE_TYPES = {
    "jab", "cross", "hook", "uppercut",
    "lead_kick", "rear_kick", "kick",  # axis = which of the fighter's legs (stance-relative,
                                       # unaffected by temporary switches); kick = axis unjudgeable
    "knee", "elbow",                   # not detectable yet — labels measure the recall gap
    "roundhouse_kick",
}


@router.post("/{clip_id}/strike-labels", status_code=status.HTTP_201_CREATED)
async def create_strike_label(
    clip_id: uuid.UUID,
    body: StrikeLabelRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record ground-truth feedback on a strike detection — training data for
    the future ML classifier. 'missed' labels carry a timestamp instead of a
    strike_id."""
    from models.strike_label import StrikeLabel
    from models.strike import Strike

    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)

    if body.label not in VALID_STRIKE_LABELS:
        raise HTTPException(status_code=422, detail=f"label must be one of {sorted(VALID_STRIKE_LABELS)}")
    if body.label == "wrong_type" and body.corrected_type not in VALID_STRIKE_TYPES:
        raise HTTPException(status_code=422, detail="wrong_type labels need a valid corrected_type")
    if body.label == "missed":
        if body.timestamp_seconds is None:
            raise HTTPException(status_code=422, detail="missed labels need timestamp_seconds")
    elif body.strike_id is None:
        raise HTTPException(status_code=422, detail=f"{body.label} labels need a strike_id")

    strike = None
    if body.strike_id is not None:
        strike = (await db.execute(
            select(Strike).join(Job, Strike.job_id == Job.id).where(
                Strike.id == uuid.UUID(body.strike_id), Job.clip_id == clip.id
            )
        )).scalar_one_or_none()
        if strike is None:
            raise HTTPException(status_code=404, detail="Strike not found on this clip")

    user = (await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))).scalar_one_or_none()
    row = StrikeLabel(
        clip_id=clip.id,
        strike_id=strike.id if strike else None,
        user_id=user.id if user else None,
        label=body.label,
        corrected_type=body.corrected_type,
        timestamp_seconds=body.timestamp_seconds if body.timestamp_seconds is not None
            else (strike.timestamp_seconds if strike else None),
        source="athlete",
    )
    db.add(row)
    await db.commit()
    return {"id": str(row.id), "label": row.label}


@router.delete("/{clip_id}/strike-labels/{label_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_strike_label(
    clip_id: uuid.UUID,
    label_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a missed-strike mark (accidental/duplicate presses in the
    labeling tool). Restricted to 'missed' rows — detection verdicts are
    corrected by re-labeling (latest wins), and their history stays."""
    from models.strike_label import StrikeLabel

    clip = await _get_clip_for_user(clip_id, clerk_user_id, db)
    row = (await db.execute(
        select(StrikeLabel).where(
            StrikeLabel.id == label_id,
            StrikeLabel.clip_id == clip.id,
            StrikeLabel.label == "missed",
        )
    )).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Missed-strike label not found on this clip")
    await db.delete(row)
    await db.commit()


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
    if body.clip_type is not None:
        if body.clip_type not in VALID_CLIP_TYPES:
            raise HTTPException(status_code=422, detail=f"clip_type must be one of {sorted(VALID_CLIP_TYPES)}")
        clip.clip_type = body.clip_type

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
        selected_subject_id=clip.selected_subject_id,
        subject_confidence=clip.subject_confidence,
        pose_quality_score=clip.pose_quality_score,
        pipeline_version=clip.pipeline_version,
        clip_type=clip.clip_type,
        session_id=str(clip.session_id) if clip.session_id else None,
        feedback=clip.feedback,
        created_at=clip.created_at,
        job=JobSummary(
            id=str(job.id),
            status=job.status,
            progress=job.progress,
            error=job.error,
            error_code=job.error_code,
        ) if job else None,
        result_url=result_url,
        video_url=video_url,
        thumbnail_url=thumbnail_url,
    )