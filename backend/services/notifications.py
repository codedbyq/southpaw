"""
Notification helpers — async for FastAPI routes, sync for the Modal inference function.
"""
import uuid
from models.notification import Notification


async def create_notification(
    db,
    user_id: uuid.UUID,
    type: str,
    title: str,
    body: str | None = None,
    reference_id: uuid.UUID | None = None,
    reference_type: str | None = None,
):
    """Async version — use in FastAPI route handlers."""
    notif = Notification(
        user_id=user_id,
        type=type,
        title=title,
        body=body,
        reference_id=reference_id,
        reference_type=reference_type,
    )
    db.add(notif)
    # Caller is responsible for committing


def create_notification_sync(
    db,
    user_id: uuid.UUID,
    type: str,
    title: str,
    body: str | None = None,
    reference_id: uuid.UUID | None = None,
    reference_type: str | None = None,
):
    """Sync version — use in the Modal inference function."""
    notif = Notification(
        user_id=user_id,
        type=type,
        title=title,
        body=body,
        reference_id=reference_id,
        reference_type=reference_type,
    )
    db.add(notif)
    # Caller is responsible for committing
