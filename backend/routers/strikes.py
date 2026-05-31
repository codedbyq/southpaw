import uuid

from fastapi import APIRouter, Depends

from dependencies import get_current_user

router = APIRouter(prefix="/clips", tags=["strikes"])


@router.get("/{clip_id}/strikes")
async def get_strikes(
    clip_id: uuid.UUID,
    type: str | None = None,
    clerk_user_id: str = Depends(get_current_user),
):
    # TODO: return strikes for clip, filterable by type
    pass
