import uuid
import logging
from datetime import datetime
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.coach_profile import CoachProfile
from core.s3 import generate_presigned_upload_url, generate_presigned_download_url
from core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/coaches", tags=["coaches"])

VALID_SPECIALIZATIONS = {
    "boxing", "muay_thai", "mma", "kickboxing", "wrestling",
    "bjj", "judo", "karate", "southpaw", "clinch", "footwork",
}


# --- Schemas ---

class CoachProfileResponse(BaseModel):
    id: str
    user_id: str
    display_name: str | None
    bio: str | None
    specializations: list[str]
    credit_rate: int | None
    review_preference: str
    rating: float | None
    review_count: int
    avg_response_hours: float | None
    is_featured: bool
    marketplace_visible: bool
    moderation_status: str
    moderation_notes: str | None
    avatar_url: str | None
    intro_video_url: str | None
    intro_video_thumb_url: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class MediaUrlRequest(BaseModel):
    media_type: Literal["avatar", "intro_video"]
    filename: str
    content_type: str


class MediaUrlResponse(BaseModel):
    upload_url: str
    s3_key: str


class MediaCompleteRequest(BaseModel):
    media_type: Literal["avatar", "intro_video"]
    s3_key: str


class CoachProfileCreateRequest(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    specializations: list[str] = []
    credit_rate: int | None = None
    review_preference: str = "either"


class CoachProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    bio: str | None = None
    specializations: list[str] | None = None
    credit_rate: int | None = None
    review_preference: str | None = None


# --- Routes ---

@router.get("/me/profile", response_model=CoachProfileResponse)
async def get_my_coach_profile(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the current user's coach profile. 404 if not created yet."""
    user = await _require_coach(clerk_user_id, db)
    profile = await _get_profile(user.id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")
    return _build_response(profile)


@router.post("/me/profile", response_model=CoachProfileResponse, status_code=status.HTTP_201_CREATED)
async def create_my_coach_profile(
    body: CoachProfileCreateRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a coach profile for the current user. Only allowed if user_type is coach."""
    user = await _require_coach(clerk_user_id, db)

    existing = await _get_profile(user.id, db)
    if existing:
        raise HTTPException(status_code=409, detail="Coach profile already exists — use PATCH to update")

    profile = CoachProfile(
        user_id=user.id,
        display_name=body.display_name,
        bio=body.bio,
        specializations=_clean_specializations(body.specializations),
        credit_rate=body.credit_rate,
        review_preference=body.review_preference,
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    logger.info(f"Created coach profile for user {user.id}")
    return _build_response(profile)


@router.patch("/me/profile", response_model=CoachProfileResponse)
async def update_my_coach_profile(
    body: CoachProfileUpdateRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the current user's coach profile."""
    user = await _require_coach(clerk_user_id, db)
    profile = await _get_profile(user.id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found — POST first")

    if body.display_name is not None:
        profile.display_name = body.display_name
    if body.bio is not None:
        profile.bio = body.bio
    if body.specializations is not None:
        profile.specializations = _clean_specializations(body.specializations)
    if body.credit_rate is not None:
        profile.credit_rate = body.credit_rate
    if body.review_preference is not None:
        if body.review_preference not in ("clip", "session", "either"):
            raise HTTPException(status_code=400, detail="review_preference must be clip, session, or either")
        profile.review_preference = body.review_preference

    await db.commit()
    await db.refresh(profile)
    return _build_response(profile)


@router.post("/me/media-url", response_model=MediaUrlResponse)
async def get_media_upload_url(
    body: MediaUrlRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a presigned S3 URL for uploading coach avatar or intro video."""
    user = await _require_coach(clerk_user_id, db)
    profile = await _get_profile(user.id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found — POST first")

    allowed_image_types = {"image/jpeg", "image/png", "image/webp"}
    allowed_video_types = {"video/mp4", "video/quicktime"}

    if body.media_type == "avatar":
        if body.content_type not in allowed_image_types:
            raise HTTPException(status_code=400, detail="Avatar must be JPEG, PNG, or WebP")
        ext = body.filename.rsplit(".", 1)[-1].lower() if "." in body.filename else "jpg"
        s3_key = f"coach-profiles/{profile.id}/avatar.{ext}"
    else:
        if body.content_type not in allowed_video_types:
            raise HTTPException(status_code=400, detail="Intro video must be MP4 or MOV")
        ext = body.filename.rsplit(".", 1)[-1].lower() if "." in body.filename else "mp4"
        s3_key = f"coach-profiles/{profile.id}/intro.{ext}"

    upload_url = generate_presigned_upload_url(s3_key, body.content_type)
    return MediaUrlResponse(upload_url=upload_url, s3_key=s3_key)


@router.post("/me/media-url/complete")
async def complete_media_upload(
    body: MediaCompleteRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Confirm a media upload and store the S3 key on the coach profile.
    For intro videos, queues thumbnail extraction.
    """
    user = await _require_coach(clerk_user_id, db)
    profile = await _get_profile(user.id, db)
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")

    if body.media_type == "avatar":
        profile.avatar_s3_key = body.s3_key
    else:
        profile.intro_video_s3_key = body.s3_key
        # Queue thumbnail extraction on Modal (same env routing as inference)
        import modal
        extract_thumb = modal.Function.from_name(
            "southpaw-inference", "extract_coach_thumbnail",
            environment_name=settings.MODAL_ENVIRONMENT or None,
        )
        await extract_thumb.spawn.aio(str(profile.id), body.s3_key)

    await db.commit()
    return {"status": "ok"}


@router.get("", response_model=list[CoachProfileResponse])
async def list_coaches(
    db: AsyncSession = Depends(get_db),
):
    """
    Public marketplace listing — approved, marketplace-visible coaches only.
    Featured coaches appear first.
    """
    result = await db.execute(
        select(CoachProfile)
        .where(
            CoachProfile.marketplace_visible == True,
            CoachProfile.moderation_status == "approved",
        )
        .order_by(CoachProfile.is_featured.desc(), CoachProfile.rating.desc().nulls_last())
    )
    profiles = result.scalars().all()
    return [_build_response(p) for p in profiles]


@router.get("/{profile_id}", response_model=CoachProfileResponse)
async def get_coach_profile(
    profile_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Public coach profile view."""
    result = await db.execute(
        select(CoachProfile).where(CoachProfile.id == profile_id)
    )
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Coach not found")
    return _build_response(profile)


# --- Helpers ---

async def _require_coach(clerk_user_id: str, db: AsyncSession) -> User:
    """Fetch user and confirm they are a coach. Raises 403 otherwise."""
    result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")
    return user


async def _get_profile(user_id: uuid.UUID, db: AsyncSession) -> CoachProfile | None:
    result = await db.execute(
        select(CoachProfile).where(CoachProfile.user_id == user_id)
    )
    return result.scalar_one_or_none()


def _clean_specializations(specs: list[str]) -> list[str]:
    """Lowercase, strip, deduplicate."""
    return list({s.strip().lower() for s in specs if s.strip()})


def _build_response(profile: CoachProfile) -> CoachProfileResponse:
    return CoachProfileResponse(
        id=str(profile.id),
        user_id=str(profile.user_id),
        display_name=profile.display_name,
        bio=profile.bio,
        specializations=profile.specializations or [],
        credit_rate=profile.credit_rate,
        review_preference=profile.review_preference or "either",
        rating=profile.rating,
        avg_response_hours=profile.avg_response_hours,
        review_count=profile.review_count,
        is_featured=profile.is_featured,
        marketplace_visible=profile.marketplace_visible,
        moderation_status=profile.moderation_status,
        moderation_notes=profile.moderation_notes,
        avatar_url=generate_presigned_download_url(profile.avatar_s3_key) if profile.avatar_s3_key else None,
        intro_video_url=generate_presigned_download_url(profile.intro_video_s3_key) if profile.intro_video_s3_key else None,
        intro_video_thumb_url=generate_presigned_download_url(profile.intro_video_thumb_s3_key) if profile.intro_video_thumb_s3_key else None,
        created_at=profile.created_at,
    )
