import logging
from datetime import datetime, timezone, timedelta
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.session import Session
from models.clip import Clip
from models.job import Job
from models.strike import Strike

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


class UserResponse(BaseModel):
    id: str
    clerk_user_id: str
    user_type: Literal["athlete", "coach"] | None  # null = onboarding not complete
    subscription_tier: Literal["free", "pro", "elite"]
    credits_balance: int
    trend_feedback: str | None
    trend_feedback_at: datetime | None
    created_at: datetime

    class Config:
        from_attributes = True


class UpdateUserRequest(BaseModel):
    user_type: Literal["athlete", "coach"]


@router.get("/me", response_model=UserResponse)
async def get_me(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's domain profile."""
    user = await _get_or_create_user(clerk_user_id, db)
    return UserResponse(
        id=str(user.id),
        clerk_user_id=user.clerk_user_id,
        user_type=user.user_type,
        subscription_tier=user.subscription_tier,
        credits_balance=user.credits_balance,
        trend_feedback=user.trend_feedback,
        trend_feedback_at=user.trend_feedback_at,
        created_at=user.created_at,
    )


@router.patch("/me", response_model=UserResponse)
async def update_me(
    body: UpdateUserRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's user_type (onboarding step)."""
    user = await _get_or_create_user(clerk_user_id, db)
    user.user_type = body.user_type
    await db.commit()

    return UserResponse(
        id=str(user.id),
        clerk_user_id=user.clerk_user_id,
        user_type=user.user_type,
        subscription_tier=user.subscription_tier,
        credits_balance=user.credits_balance,
        trend_feedback=user.trend_feedback,
        trend_feedback_at=user.trend_feedback_at,
        created_at=user.created_at,
    )


@router.get("/me/stats")
async def get_my_stats(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Instant stats for the dashboard stats bar — no LLM, pure aggregation.
    Returns: this_week (sessions, strikes, guard_drop_rate), streak_weeks, all_time totals.
    """
    now = datetime.now(timezone.utc)
    # Start of current week (Monday 00:00 UTC)
    start_of_week = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    # --- Sessions this week ---
    sessions_week_result = await db.execute(
        select(func.count(Session.id))
        .where(
            Session.clerk_user_id == clerk_user_id,
            Session.created_at >= start_of_week,
        )
    )
    sessions_this_week = sessions_week_result.scalar() or 0

    # --- All sessions (for streak) — fetch dates, compute weeks in Python ---
    all_sessions_result = await db.execute(
        select(Session.created_at)
        .where(Session.clerk_user_id == clerk_user_id)
        .order_by(Session.created_at.desc())
    )
    session_dates = [row[0] for row in all_sessions_result]

    def _week_start(dt):
        dt_utc = dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt
        return (dt_utc - timedelta(days=dt_utc.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0
        )

    # Unique weeks with sessions, newest first
    session_weeks = sorted(set(_week_start(d) for d in session_dates), reverse=True)

    # Streak = consecutive weeks ending at (or including) current week
    streak = 0
    for i, week in enumerate(session_weeks):
        expected = start_of_week - timedelta(weeks=i)
        if week == expected:
            streak += 1
        else:
            break

    # --- Strikes this week ---
    # Join: sessions → clips → jobs → strikes, filtered to this week's sessions
    week_sessions_result = await db.execute(
        select(Session.id)
        .where(
            Session.clerk_user_id == clerk_user_id,
            Session.created_at >= start_of_week,
        )
    )
    week_session_ids = [r[0] for r in week_sessions_result]

    strikes_this_week = 0
    guard_drop_rate_week = None

    if week_session_ids:
        clips_result = await db.execute(
            select(Clip.id).where(Clip.session_id.in_(week_session_ids))
        )
        clip_ids = [r[0] for r in clips_result]

        if clip_ids:
            jobs_result = await db.execute(
                select(Job.id).where(
                    Job.clip_id.in_(clip_ids),
                    Job.status == "complete",
                )
            )
            job_ids = [r[0] for r in jobs_result]

            if job_ids:
                strike_stats = await db.execute(
                    select(
                        func.count(Strike.id).label("total"),
                        func.count(Strike.id).filter(Strike.guard_dropped == True).label("dropped"),
                        func.count(Strike.id).filter(Strike.guard_dropped.is_not(None)).label("measured"),
                    ).where(Strike.job_id.in_(job_ids))
                )
                row = strike_stats.one()
                strikes_this_week = row.total or 0
                if row.measured and row.measured > 0:
                    guard_drop_rate_week = round(row.dropped / row.measured, 3)

    # --- All time totals ---
    all_clips_result = await db.execute(
        select(Clip.id).where(Clip.clerk_user_id == clerk_user_id)
    )
    all_clip_ids = [r[0] for r in all_clips_result]

    total_strikes = 0
    if all_clip_ids:
        all_jobs_result = await db.execute(
            select(Job.id).where(
                Job.clip_id.in_(all_clip_ids),
                Job.status == "complete",
            )
        )
        all_job_ids = [r[0] for r in all_jobs_result]
        if all_job_ids:
            total_result = await db.execute(
                select(func.count(Strike.id)).where(Strike.job_id.in_(all_job_ids))
            )
            total_strikes = total_result.scalar() or 0

    all_sessions_count_result = await db.execute(
        select(func.count(Session.id)).where(Session.clerk_user_id == clerk_user_id)
    )
    total_sessions = all_sessions_count_result.scalar() or 0

    return {
        "this_week": {
            "sessions": sessions_this_week,
            "strikes": strikes_this_week,
            "guard_drop_rate": guard_drop_rate_week,
        },
        "streak_weeks": streak,
        "all_time": {
            "sessions": total_sessions,
            "strikes": total_strikes,
        },
    }


async def _get_or_create_user(clerk_user_id: str, db: AsyncSession) -> User:
    """
    Fetch the user row, creating it if it doesn't exist.
    Acts as a safety net for users who signed up before the webhook was configured.
    """
    result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = result.scalar_one_or_none()
    if not user:
        logger.info(f"No user row found for {clerk_user_id} — creating via get_or_create")
        user = User(clerk_user_id=clerk_user_id)
        db.add(user)
        await db.commit()
        await db.refresh(user)
    return user
