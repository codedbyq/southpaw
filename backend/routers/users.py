import logging
from datetime import datetime
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["users"])


class UserResponse(BaseModel):
    id: str
    clerk_user_id: str
    user_type: Literal["athlete", "coach"] | None  # null = onboarding not complete
    subscription_tier: Literal["free", "pro", "elite"]
    credits_balance: int
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
        created_at=user.created_at,
    )


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
