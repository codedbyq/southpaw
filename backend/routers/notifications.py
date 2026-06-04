import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.notification import Notification

router = APIRouter(prefix="/notifications", tags=["notifications"])


class NotificationResponse(BaseModel):
    id: str
    type: str
    title: str
    body: str | None
    reference_id: str | None
    reference_type: str | None
    read: bool
    created_at: datetime

    class Config:
        from_attributes = True


@router.get("", response_model=list[NotificationResponse])
async def list_notifications(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's notifications, unread first then newest."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        return []

    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == user.id)
        .order_by(Notification.read.asc(), Notification.created_at.desc())
        .limit(50)
    )
    notifications = result.scalars().all()

    return [
        NotificationResponse(
            id=str(n.id),
            type=n.type,
            title=n.title,
            body=n.body,
            reference_id=str(n.reference_id) if n.reference_id else None,
            reference_type=n.reference_type,
            read=n.read,
            created_at=n.created_at,
        )
        for n in notifications
    ]


@router.patch("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark all notifications as read."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        return

    result = await db.execute(
        select(Notification).where(
            Notification.user_id == user.id,
            Notification.read == False,
        )
    )
    for notif in result.scalars().all():
        notif.read = True
    await db.commit()


@router.patch("/{notification_id}/read", status_code=status.HTTP_204_NO_CONTENT)
async def mark_read(
    notification_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a single notification as read."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        return

    result = await db.execute(
        select(Notification).where(
            Notification.id == notification_id,
            Notification.user_id == user.id,
        )
    )
    notif = result.scalar_one_or_none()
    if notif:
        notif.read = True
        await db.commit()
