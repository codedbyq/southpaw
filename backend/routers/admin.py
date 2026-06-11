import uuid
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.coach_profile import CoachProfile
from services.notifications import create_notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


# --- Schemas ---

class CoachProfileAdminView(BaseModel):
    id: str
    user_id: str
    display_name: str | None
    bio: str | None
    specializations: list[str]
    credit_rate: int | None
    moderation_status: str
    moderation_notes: str | None
    marketplace_visible: bool
    review_count: int
    created_at: datetime

    class Config:
        from_attributes = True


class ModerationAction(BaseModel):
    notes: str | None = None


# --- Auth dependency ---

async def require_admin(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = result.scalar_one_or_none()
    if not user or not user.is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


# --- Labeling queue (golden-set annotation workflow) ---

@router.get("/label-queue")
async def label_queue(
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """The admin's own processed clips with detection counts and label
    coverage — the worklist for the LabelPlayerPage. Labels post through the
    owner-scoped /clips/:id/strike-labels endpoint, so the queue only lists
    clips the admin uploaded."""
    from models.clip import Clip
    from models.job import Job
    from models.strike import Strike
    from models.strike_label import StrikeLabel

    clips = (await db.execute(
        select(Clip).where(Clip.clerk_user_id == admin.clerk_user_id)
        .order_by(Clip.created_at.desc())
    )).scalars().all()
    if not clips:
        return []

    clip_ids = [c.id for c in clips]
    detection_counts = dict((await db.execute(
        select(Job.clip_id, func.count(Strike.id))
        .join(Strike, Strike.job_id == Job.id)
        .where(Job.clip_id.in_(clip_ids))
        .group_by(Job.clip_id)
    )).all())
    labeled_counts = dict((await db.execute(
        select(StrikeLabel.clip_id, func.count(func.distinct(StrikeLabel.strike_id)))
        .where(StrikeLabel.clip_id.in_(clip_ids), StrikeLabel.strike_id.isnot(None))
        .group_by(StrikeLabel.clip_id)
    )).all())

    return [
        {
            "id": str(c.id),
            "filename": c.filename,
            "status": c.status,
            "clip_type": c.clip_type,
            "duration_seconds": c.duration_seconds,
            "created_at": c.created_at.isoformat() if c.created_at else None,
            "detections": detection_counts.get(c.id, 0),
            "labeled": labeled_counts.get(c.id, 0),
        }
        for c in clips
    ]


@router.get("/clips/{clip_id}/strike-labels")
async def clip_strike_labels(
    clip_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Existing labels for a clip so the labeling page can resume progress —
    latest verdict per strike, plus missed-strike marks."""
    from models.strike_label import StrikeLabel

    rows = (await db.execute(
        select(StrikeLabel).where(StrikeLabel.clip_id == clip_id)
        .order_by(StrikeLabel.created_at.asc())
    )).scalars().all()

    verdicts: dict = {}
    missed = []
    for r in rows:
        if r.label == "missed":
            missed.append({
                "id": str(r.id),
                "timestamp_seconds": r.timestamp_seconds,
                "corrected_type": r.corrected_type,
            })
        elif r.strike_id is not None:
            # chronological order — later rows overwrite, so latest verdict wins
            verdicts[str(r.strike_id)] = {"label": r.label, "corrected_type": r.corrected_type}
    return {"verdicts": verdicts, "missed": missed}


# --- Routes ---

@router.get("/coaches", response_model=list[CoachProfileAdminView])
async def list_coach_profiles(
    moderation_status: str | None = None,   # filter by status
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """List all coach profiles, optionally filtered by moderation status."""
    query = select(CoachProfile).order_by(CoachProfile.created_at.desc())
    if moderation_status:
        query = query.where(CoachProfile.moderation_status == moderation_status)
    result = await db.execute(query)
    profiles = result.scalars().all()
    return [_build_view(p) for p in profiles]


@router.patch("/coaches/{profile_id}/approve", response_model=CoachProfileAdminView)
async def approve_coach(
    profile_id: uuid.UUID,
    body: ModerationAction,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Approve a coach profile — makes them visible in the marketplace."""
    profile = await _get_profile(profile_id, db)

    was_pending = profile.moderation_status == "pending"
    profile.moderation_status = "approved"
    profile.marketplace_visible = True
    if body.notes:
        profile.moderation_notes = body.notes

    # Notify coach they're approved
    if was_pending:
        await create_notification(
            db,
            user_id=profile.user_id,
            type="coach_approved",
            title="Your coach profile is approved",
            body="Your profile is now live in the Southpaw marketplace. Athletes can find and request reviews from you.",
            reference_type="coach_profile",
        )

    await db.commit()
    logger.info(f"Admin {admin.id} approved coach profile {profile_id}")
    return _build_view(profile)


@router.patch("/coaches/{profile_id}/reject", response_model=CoachProfileAdminView)
async def reject_coach(
    profile_id: uuid.UUID,
    body: ModerationAction,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Reject a coach profile with an optional reason."""
    profile = await _get_profile(profile_id, db)

    profile.moderation_status = "rejected"
    profile.marketplace_visible = False
    profile.moderation_notes = body.notes

    # Notify coach of rejection with reason
    reason = f" Reason: {body.notes}" if body.notes else " Please update your profile and resubmit."
    await create_notification(
        db,
        user_id=profile.user_id,
        type="coach_rejected",
        title="Coach profile needs updates",
        body=f"Your profile was not approved at this time.{reason}",
        reference_type="coach_profile",
    )

    await db.commit()
    logger.info(f"Admin {admin.id} rejected coach profile {profile_id}")
    return _build_view(profile)


@router.patch("/coaches/{profile_id}/feature", response_model=CoachProfileAdminView)
async def toggle_featured(
    profile_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Toggle featured status on an approved coach."""
    profile = await _get_profile(profile_id, db)
    if profile.moderation_status != "approved":
        raise HTTPException(status_code=400, detail="Only approved coaches can be featured")
    profile.is_featured = not profile.is_featured
    await db.commit()
    return _build_view(profile)


# --- Helpers ---

async def _get_profile(profile_id: uuid.UUID, db: AsyncSession) -> CoachProfile:
    result = await db.execute(select(CoachProfile).where(CoachProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")
    return profile


def _build_view(profile: CoachProfile) -> CoachProfileAdminView:
    return CoachProfileAdminView(
        id=str(profile.id),
        user_id=str(profile.user_id),
        display_name=profile.display_name,
        bio=profile.bio,
        specializations=profile.specializations or [],
        credit_rate=profile.credit_rate,
        moderation_status=profile.moderation_status,
        moderation_notes=profile.moderation_notes,
        marketplace_visible=profile.marketplace_visible,
        review_count=profile.review_count,
        created_at=profile.created_at,
    )


# --- Processing jobs debug view ---

@router.get("/jobs")
async def list_jobs(
    status_filter: str | None = None,    # queued | processing | complete | failed
    limit: int = 50,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    """Recent processing jobs with diagnostics — the ops view for "my video is
    stuck/wrong" reports. Read-only; one query, newest first."""
    from models.job import Job
    from models.clip import Clip

    query = (
        select(Job, Clip)
        .join(Clip, Job.clip_id == Clip.id)
        .order_by(Job.created_at.desc().nullslast())
        .limit(min(limit, 200))
    )
    if status_filter:
        query = query.where(Job.status == status_filter)

    rows = (await db.execute(query)).all()
    out = []
    for job, clip in rows:
        diag = job.diagnostics or {}
        out.append({
            "job_id": str(job.id),
            "clip_id": str(clip.id),
            "filename": clip.filename,
            "clerk_user_id": clip.clerk_user_id,
            "status": job.status,
            "progress": job.progress,
            "error": job.error,
            "error_code": job.error_code,
            "attempt": job.attempt,
            "created_at": job.created_at,
            "started_at": job.started_at,
            "completed_at": job.completed_at,
            "heartbeat_at": job.heartbeat_at,
            "pipeline_version": clip.pipeline_version,
            "pose_quality_score": clip.pose_quality_score,
            "subject_confidence": clip.subject_confidence,
            "model": diag.get("model"),
            "fps": diag.get("fps"),
            "frames_processed": diag.get("frames_processed"),
            "subjects_detected": diag.get("subjects_detected"),
            "strikes_persisted": diag.get("strikes_persisted"),
            "strikes_low_confidence": diag.get("strikes_low_confidence"),
            "stage_timings": diag.get("stage_timings"),
        })
    return out
