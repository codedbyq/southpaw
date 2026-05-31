import uuid

from fastapi import APIRouter, Depends

from dependencies import get_current_user

router = APIRouter(prefix="/clips", tags=["clips"])


@router.get("")
async def list_clips(clerk_user_id: str = Depends(get_current_user)):
    # TODO: return paginated clips for user
    pass


@router.get("/{clip_id}")
async def get_clip(clip_id: uuid.UUID, clerk_user_id: str = Depends(get_current_user)):
    # TODO: return single clip with result S3 URL if processed
    pass


@router.delete("/{clip_id}")
async def delete_clip(clip_id: uuid.UUID, clerk_user_id: str = Depends(get_current_user)):
    # TODO: delete clip from S3 + DB
    pass
