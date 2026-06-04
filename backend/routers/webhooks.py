import logging
from fastapi import APIRouter, Request, HTTPException, Header
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from svix.webhooks import Webhook, WebhookVerificationError

from db.session import get_db
from models.user import User
from core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/clerk")
async def clerk_webhook(
    request: Request,
    svix_id: str = Header(None, alias="svix-id"),
    svix_timestamp: str = Header(None, alias="svix-timestamp"),
    svix_signature: str = Header(None, alias="svix-signature"),
):
    """
    Receive Clerk webhook events.
    Currently handles: user.created, user.deleted
    """
    if not all([svix_id, svix_timestamp, svix_signature]):
        raise HTTPException(status_code=400, detail="Missing svix headers")

    payload = await request.body()

    try:
        wh = Webhook(settings.CLERK_WEBHOOK_SECRET)
        event = wh.verify(payload, {
            "svix-id": svix_id,
            "svix-timestamp": svix_timestamp,
            "svix-signature": svix_signature,
        })
    except WebhookVerificationError:
        raise HTTPException(status_code=401, detail="Invalid webhook signature")
    event_type = event.get("type")
    data = event.get("data", {})

    logger.info(f"Clerk webhook received: {event_type}")

    async for db in get_db():
        if event_type == "user.created":
            await _handle_user_created(data, db)
        elif event_type == "user.deleted":
            await _handle_user_deleted(data, db)
        else:
            logger.info(f"Unhandled webhook event type: {event_type}")

    return {"status": "ok"}


async def _handle_user_created(data: dict, db: AsyncSession):
    """Create a users row when a new Clerk user registers."""
    clerk_user_id = data.get("id")
    if not clerk_user_id:
        logger.warning("user.created event missing id")
        return

    # Idempotent — do nothing if the row already exists
    existing = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    if existing.scalar_one_or_none():
        logger.info(f"User already exists for clerk_user_id={clerk_user_id}, skipping")
        return

    user = User(clerk_user_id=clerk_user_id)
    db.add(user)
    await db.commit()
    logger.info(f"Created user row for clerk_user_id={clerk_user_id}")


async def _handle_user_deleted(data: dict, db: AsyncSession):
    """Delete the users row when a Clerk user is deleted."""
    clerk_user_id = data.get("id")
    if not clerk_user_id:
        logger.warning("user.deleted event missing id")
        return

    result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = result.scalar_one_or_none()
    if user:
        await db.delete(user)
        await db.commit()
        logger.info(f"Deleted user row for clerk_user_id={clerk_user_id}")
    else:
        logger.info(f"No user row found for clerk_user_id={clerk_user_id}, skipping delete")
