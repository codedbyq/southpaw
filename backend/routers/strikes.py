import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.clip import Clip
from models.job import Job
from models.strike import Strike

router = APIRouter(prefix="/clips", tags=["strikes"])


@router.get("/{clip_id}/strikes")
async def get_strikes(
    clip_id: uuid.UUID,
    type: str | None = None,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return detected strikes for a clip, ordered by timestamp. Optionally filter by type."""
    clip = (await db.execute(
        select(Clip).where(Clip.id == clip_id, Clip.clerk_user_id == clerk_user_id)
    )).scalar_one_or_none()
    if clip is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Clip not found")

    job_ids = [r[0] for r in (await db.execute(
        select(Job.id).where(Job.clip_id == clip.id)
    )).all()]
    if not job_ids:
        return []

    query = select(Strike).where(Strike.job_id.in_(job_ids)).order_by(Strike.timestamp_seconds.asc())
    if type:
        query = query.where(Strike.type == type)
    strikes = (await db.execute(query)).scalars().all()

    return [
        {
            "id": str(s.id),
            "type": s.type,
            "timestamp_seconds": s.timestamp_seconds,
            "frame_index": s.frame_index,
            "confidence": s.confidence,
            "arm_extension": s.arm_extension,
            "guard_dropped": s.guard_dropped,
        }
        for s in strikes
    ]
