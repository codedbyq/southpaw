import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
from datetime import datetime

from dependencies import get_current_user
from db.session import get_db
from models.session import Session
from models.clip import Clip
from models.job import Job
from models.strike import Strike
from routers.clips import _build_clip_response, ClipResponse
from services.feedback import build_session_summary, generate_feedback

router = APIRouter(prefix="/sessions", tags=["sessions"])


# --- Schemas ---

class SessionCreateRequest(BaseModel):
    label: str | None = None
    sport: str = "boxing"
    session_type: str | None = None
    notes: str | None = None


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
    created_at: datetime
    clips: list[ClipResponse]
    metrics: SessionMetrics


# --- Routes ---

@router.get("", response_model=list[SessionResponse])
async def list_sessions(
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Session)
        .where(Session.clerk_user_id == user_id)
        .order_by(Session.created_at.desc())
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
        created_at=session.created_at,
        clips=clip_responses,
        metrics=metrics,
    )


@router.get("/{session_id}/feedback")
async def get_session_feedback(
    session_id: uuid.UUID,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate LLM coaching feedback for a session. Calls DeepSeek on every request."""
    session = await _get_session_for_user(session_id, user_id, db)

    clips_result = await db.execute(
        select(Clip).where(Clip.session_id == session_id, Clip.clerk_user_id == user_id)
    )
    clips = clips_result.scalars().all()

    if not clips:
        raise HTTPException(status_code=400, detail="No clips in this session yet")

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

    try:
        summary = build_session_summary(session, clips, strikes)
        feedback = await generate_feedback(summary)
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
