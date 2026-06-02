import uuid
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.coach_profile import CoachProfile

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
    bio: str | None
    specializations: list[str]
    credit_rate: int | None
    rating: float | None
    review_count: int
    is_featured: bool
    marketplace_visible: bool
    moderation_status: str
    moderation_notes: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class CoachProfileCreateRequest(BaseModel):
    bio: str | None = None
    specializations: list[str] = []
    credit_rate: int | None = None


class CoachProfileUpdateRequest(BaseModel):
    bio: str | None = None
    specializations: list[str] | None = None
    credit_rate: int | None = None


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
        bio=body.bio,
        specializations=_clean_specializations(body.specializations),
        credit_rate=body.credit_rate,
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

    if body.bio is not None:
        profile.bio = body.bio
    if body.specializations is not None:
        profile.specializations = _clean_specializations(body.specializations)
    if body.credit_rate is not None:
        profile.credit_rate = body.credit_rate

    await db.commit()
    await db.refresh(profile)
    return _build_response(profile)


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
        bio=profile.bio,
        specializations=profile.specializations or [],
        credit_rate=profile.credit_rate,
        rating=profile.rating,
        review_count=profile.review_count,
        is_featured=profile.is_featured,
        marketplace_visible=profile.marketplace_visible,
        moderation_status=profile.moderation_status,
        moderation_notes=profile.moderation_notes,
        created_at=profile.created_at,
    )
