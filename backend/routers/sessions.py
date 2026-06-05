import uuid
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel

from dependencies import get_current_user
from db.session import get_db
from models.session import Session
from models.clip import Clip
from models.job import Job
from models.strike import Strike
from routers.clips import _build_clip_response, ClipResponse
from services.feedback import build_session_summary, compute_session_hash, generate_feedback, build_trend_summary, generate_trend_feedback, _aggregate_combos, _compute_fatigue_curve
from models.user import User

router = APIRouter(prefix="/sessions", tags=["sessions"])


# --- Schemas ---

class SessionCreateRequest(BaseModel):
    label: str | None = None
    sport: str = "boxing"
    session_type: str | None = None
    notes: str | None = None
    training_phase: str | None = None  # fight_camp | off_season | recovery | regular
    opponent_context: str | None = None


class SessionUpdateRequest(BaseModel):
    label: str | None = None
    sport: str | None = None
    session_type: str | None = None
    notes: str | None = None
    training_phase: str | None = None
    opponent_context: str | None = None


class SessionResponse(BaseModel):
    id: str
    label: str | None
    sport: str
    session_type: str | None
    created_at: datetime
    # Dashboard metrics — populated by list_sessions, None on create
    clip_count: int | None = None
    total_strikes: int | None = None
    strikes_per_minute: float | None = None
    guard_drop_rate: float | None = None

    class Config:
        from_attributes = True


class SessionMetrics(BaseModel):
    total_strikes: int
    strikes_per_minute: float | None   # None if no clips have duration yet
    guard_drop_rate: float | None      # None until arm_extension metrics are populated
    avg_arm_extension: float | None


class SessionDetailResponse(BaseModel):
    id: str
    label: str | None
    sport: str
    session_type: str | None
    notes: str | None
    training_phase: str | None
    opponent_context: str | None
    created_at: datetime
    clips: list[ClipResponse]
    metrics: SessionMetrics
    llm_summary: str | None = None
    llm_summary_dirty: bool = True


# --- Routes ---

@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 20,
    offset: int = 0,
):
    result = await db.execute(
        select(Session)
        .where(Session.clerk_user_id == user_id, Session.deleted_at == None)
        .order_by(Session.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    sessions = result.scalars().all()

    responses = []
    for s in sessions:
        metrics = await _session_list_metrics(s.id, db)
        responses.append(SessionResponse(
            id=str(s.id),
            label=s.label,
            sport=s.sport,
            session_type=s.session_type,
            created_at=s.created_at,
            **metrics,
        ))
    return responses


@router.get("/trend-feedback")
async def get_trend_feedback(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Generate and cache trend feedback across the user's last 5 sessions.
    Requires at least 2 sessions with processed strikes. Requires Elite.
    """
    # Gate behind Elite tier
    current_user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    current_user = current_user_result.scalar_one_or_none()
    if current_user and current_user.subscription_tier not in ("pro", "elite"):
        raise HTTPException(status_code=402, detail="Trend feedback requires a Pro or Elite subscription")

    # Fetch last 5 sessions oldest → newest
    sessions_result = await db.execute(
        select(Session)
        .where(Session.clerk_user_id == clerk_user_id)
        .order_by(Session.created_at.asc())
        .limit(5)
    )
    sessions = sessions_result.scalars().all()

    if len(sessions) < 2:
        raise HTTPException(status_code=400, detail="At least 2 sessions needed for trend analysis")

    # Gather strikes per session
    strikes_by_session: dict[str, list] = {}
    for session in sessions:
        clips_result = await db.execute(
            select(Clip).where(Clip.session_id == session.id)
        )
        clips = clips_result.scalars().all()
        if not clips:
            continue

        jobs_result = await db.execute(
            select(Job).where(
                Job.clip_id.in_([c.id for c in clips]),
                Job.status == "complete",
            )
        )
        jobs = jobs_result.scalars().all()
        if not jobs:
            continue

        strikes_result = await db.execute(
            select(Strike).where(Strike.job_id.in_([j.id for j in jobs]))
        )
        strikes_by_session[str(session.id)] = strikes_result.scalars().all()

    sessions_with_data = [s for s in sessions if strikes_by_session.get(str(s.id))]
    if len(sessions_with_data) < 2:
        raise HTTPException(
            status_code=400,
            detail="At least 2 sessions with processed clips needed for trend analysis",
        )

    # Build summary and generate feedback
    summary = build_trend_summary(sessions_with_data, strikes_by_session)
    try:
        feedback = await generate_trend_feedback(summary)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to generate trend feedback: {e}")

    # Cache on user row
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if user:
        user.trend_feedback = feedback
        user.trend_feedback_at = datetime.now(timezone.utc)
        await db.commit()

    return {
        "feedback": feedback,
        "session_count": len(sessions_with_data),
    }


@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = await _get_session_for_user(session_id, user_id, db)

    # Clips in this session
    clips_result = await db.execute(
        select(Clip)
        .where(Clip.session_id == session_id, Clip.clerk_user_id == user_id)
        .order_by(Clip.created_at.asc())
    )
    clips = clips_result.scalars().all()
    clip_responses = [await _build_clip_response(clip, db) for clip in clips]

    # Strikes across all jobs for clips in this session
    job_ids_result = await db.execute(
        select(Job.id).where(Job.clip_id.in_([c.id for c in clips]))
    )
    job_ids = [row[0] for row in job_ids_result.all()]

    strikes = []
    if job_ids:
        strikes_result = await db.execute(
            select(Strike).where(Strike.job_id.in_(job_ids))
        )
        strikes = strikes_result.scalars().all()

    metrics = _calculate_metrics(clips, strikes)

    return SessionDetailResponse(
        id=str(session.id),
        label=session.label,
        sport=session.sport,
        session_type=session.session_type,
        notes=session.notes,
        training_phase=session.training_phase,
        opponent_context=session.opponent_context,
        created_at=session.created_at,
        clips=clip_responses,
        metrics=metrics,
        llm_summary=session.llm_summary,
        llm_summary_dirty=session.llm_summary_dirty,
    )


@router.get("/{session_id}/analytics")
async def get_session_analytics(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return combo and fatigue curve analytics for a session."""
    session = await _get_session_for_user(session_id, user_id, db)

    clips_result = await db.execute(
        select(Clip).where(Clip.session_id == session.id)
    )
    clips = clips_result.scalars().all()

    strikes = []
    if clips:
        job_ids_result = await db.execute(
            select(Job.id).where(Job.clip_id.in_([c.id for c in clips]))
        )
        job_ids = [r[0] for r in job_ids_result]
        if job_ids:
            strikes_result = await db.execute(
                select(Strike).where(Strike.job_id.in_(job_ids))
            )
            strikes = strikes_result.scalars().all()

    total_duration = sum(c.duration_seconds or 0 for c in clips)

    # Average head movement across clips
    head_scores = [c.head_movement_score for c in clips if c.head_movement_score is not None]
    avg_head_movement = round(sum(head_scores) / len(head_scores), 3) if head_scores else None

    return {
        "combos": _aggregate_combos(strikes),
        "fatigue_curve": _compute_fatigue_curve(strikes, total_duration),
        "head_movement_score": avg_head_movement,
    }


@router.get("/{session_id}/feedback")
async def get_session_feedback(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return cached LLM feedback or generate fresh if dirty/missing. Requires Pro+."""
    current_user_result = await db.execute(select(User).where(User.clerk_user_id == user_id))
    current_user = current_user_result.scalar_one_or_none()
    if current_user and current_user.subscription_tier == "free":
        raise HTTPException(status_code=402, detail="Session feedback requires a Pro or Elite subscription")

    session = await _get_session_for_user(session_id, user_id, db)

    clips_result = await db.execute(
        select(Clip).where(Clip.session_id == session_id, Clip.clerk_user_id == user_id)
    )
    clips = clips_result.scalars().all()

    if not clips:
        raise HTTPException(status_code=400, detail="No clips in this session yet")

    if len(clips) < 2:
        raise HTTPException(
            status_code=400,
            detail="Session feedback requires at least 2 clips — single clip sessions already have clip-level feedback"
        )

    job_ids_result = await db.execute(
        select(Job.id).where(Job.clip_id.in_([c.id for c in clips]))
    )
    job_ids = [row[0] for row in job_ids_result.all()]

    strikes = []
    if job_ids:
        strikes_result = await db.execute(
            select(Strike).where(Strike.job_id.in_(job_ids))
        )
        strikes = strikes_result.scalars().all()

    if not strikes:
        raise HTTPException(status_code=400, detail="No processed strikes in this session yet — upload and process a clip first")

    # Fetch user for experience level context
    user_result = await db.execute(select(User).where(User.clerk_user_id == user_id))
    current_user = user_result.scalar_one_or_none()

    summary = build_session_summary(session, clips, strikes, user=current_user)
    current_hash = compute_session_hash(summary)

    # Return cached feedback if the session is clean and the data hasn't changed
    if session.llm_summary and not session.llm_summary_dirty and session.llm_summary_hash == current_hash:
        return {"feedback": session.llm_summary}

    try:
        from services.feedback import LLM_MODELS
        llm_model = LLM_MODELS.get(current_user.subscription_tier if current_user else "pro", "deepseek-chat")
        feedback = await generate_feedback(summary, llm_model=llm_model)
        session.llm_summary = feedback
        session.llm_summary_hash = current_hash
        session.llm_summary_dirty = False
        session.llm_summary_at = datetime.now(timezone.utc)
        await db.commit()
        return {"feedback": feedback}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"LLM call failed: {exc}")


@router.post("", response_model=SessionResponse, status_code=201)
async def create_session(
    body: SessionCreateRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    session = Session(
        clerk_user_id=user_id,
        label=body.label,
        sport=body.sport,
        session_type=body.session_type,
        notes=body.notes,
        training_phase=body.training_phase,
        opponent_context=body.opponent_context,
    )
    db.add(session)
    await db.commit()
    await db.refresh(session)
    return SessionResponse(
        id=str(session.id),
        label=session.label,
        sport=session.sport,
        session_type=session.session_type,
        created_at=session.created_at,
    )


@router.patch("/{session_id}", response_model=SessionDetailResponse)
async def update_session(
    session_id: uuid.UUID,
    body: SessionUpdateRequest,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update session label, sport, type, or notes."""
    session = await _get_session_for_user(session_id, user_id, db)

    if body.label is not None:
        session.label = body.label
    if body.sport is not None:
        session.sport = body.sport
    if body.session_type is not None:
        session.session_type = body.session_type
    if body.notes is not None:
        session.notes = body.notes
    if body.training_phase is not None:
        session.training_phase = body.training_phase
    if body.opponent_context is not None:
        session.opponent_context = body.opponent_context

    # Changing notes marks feedback dirty
    if body.notes is not None:
        session.llm_summary_dirty = True

    await db.commit()
    await db.refresh(session)

    clips_result = await db.execute(select(Clip).where(Clip.session_id == session.id))
    clips = clips_result.scalars().all()
    clip_responses = [await _build_clip_response(c, db) for c in clips]
    metrics = _calculate_metrics(clips, [])

    return SessionDetailResponse(
        id=str(session.id),
        label=session.label,
        sport=session.sport,
        session_type=session.session_type,
        notes=session.notes,
        training_phase=session.training_phase,
        opponent_context=session.opponent_context,
        created_at=session.created_at,
        clips=clip_responses,
        metrics=metrics,
        llm_summary=session.llm_summary,
        llm_summary_dirty=session.llm_summary_dirty,
    )


@router.get("/{session_id}/clip-count")
async def get_session_clip_count(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return clip count for delete confirmation prompt."""
    session = await _get_session_for_user(session_id, user_id, db)
    result = await db.execute(
        select(func.count(Clip.id)).where(Clip.session_id == session.id)
    )
    return {"clip_count": result.scalar() or 0}


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Soft delete a session — sets deleted_at, moves all clips to unorganized
    (session_id = null) so they remain accessible on the dashboard.
    """
    session = await _get_session_for_user(session_id, user_id, db)

    # Unorganize all clips belonging to this session
    clips_result = await db.execute(
        select(Clip).where(Clip.session_id == session.id)
    )
    for clip in clips_result.scalars().all():
        clip.session_id = None

    session.deleted_at = datetime.now(timezone.utc)
    await db.commit()


# --- Helpers ---

async def _session_list_metrics(session_id: uuid.UUID, db: AsyncSession) -> dict:
    """Lightweight metrics for the session list view. Two queries per session."""
    # Clip count + total duration
    clip_stats = await db.execute(
        select(
            func.count(Clip.id).label("count"),
            func.coalesce(func.sum(Clip.duration_seconds), 0).label("duration"),
        ).where(Clip.session_id == session_id)
    )
    clip_row = clip_stats.one()
    clip_count = clip_row.count
    total_duration = clip_row.duration

    if clip_count == 0:
        return {"clip_count": 0, "total_strikes": 0, "strikes_per_minute": None, "guard_drop_rate": None}

    # Strike count + guard discipline via join clips → jobs → strikes
    strike_stats = await db.execute(
        select(
            func.count(Strike.id).label("total"),
            func.count(Strike.id).filter(Strike.guard_dropped == True).label("dropped"),
            func.count(Strike.id).filter(Strike.guard_dropped.isnot(None)).label("measured"),
        )
        .join(Job, Job.id == Strike.job_id)
        .join(Clip, Clip.id == Job.clip_id)
        .where(Clip.session_id == session_id)
    )
    s = strike_stats.one()
    total_strikes = s.total or 0
    guard_drop_rate = round(s.dropped / s.measured, 3) if s.measured else None
    strikes_per_minute = round(total_strikes / (total_duration / 60), 1) if total_duration > 0 and total_strikes > 0 else None

    return {
        "clip_count": clip_count,
        "total_strikes": total_strikes,
        "strikes_per_minute": strikes_per_minute,
        "guard_drop_rate": guard_drop_rate,
    }


async def _get_session_for_user(
    session_id: uuid.UUID,
    user_id: str,
    db: AsyncSession,
) -> Session:
    result = await db.execute(
        select(Session).where(
            Session.id == session_id,
            Session.clerk_user_id == user_id,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return session


def _calculate_metrics(clips, strikes) -> SessionMetrics:
    total_strikes = len(strikes)

    total_duration = sum(c.duration_seconds or 0 for c in clips)
    strikes_per_minute = round(total_strikes / (total_duration / 60), 1) if total_duration > 0 else None

    arm_extensions = [s.arm_extension for s in strikes if s.arm_extension is not None]
    avg_arm_extension = round(sum(arm_extensions) / len(arm_extensions), 3) if arm_extensions else None

    guard_drop_values = [s.guard_dropped for s in strikes if s.guard_dropped is not None]
    guard_drop_rate = round(sum(guard_drop_values) / len(guard_drop_values), 3) if guard_drop_values else None

    return SessionMetrics(
        total_strikes=total_strikes,
        strikes_per_minute=strikes_per_minute,
        guard_drop_rate=guard_drop_rate,
        avg_arm_extension=avg_arm_extension,
    )
