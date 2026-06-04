import uuid
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.clip import Clip
from models.clip_review import ClipReview
from models.credit_transaction import CreditTransaction
from models.coach_profile import CoachProfile
from core.s3 import generate_presigned_download_url
from services.notifications import create_notification

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reviews", tags=["reviews"])


# --- Schemas ---

class ReviewCreateRequest(BaseModel):
    coach_profile_id: str       # coach_profiles.id
    clip_id: str | None = None
    session_id: str | None = None
    athlete_note: str | None = None


class ReviewResponse(BaseModel):
    id: str
    clip_id: str | None
    coach_id: str
    athlete_id: str
    status: str
    credits_cost: int
    athlete_note: str | None
    athlete_rating: int | None
    created_at: datetime
    completed_at: datetime | None
    # Enriched
    clip_thumbnail_url: str | None
    clip_filename: str | None
    session_id: str | None
    session_label: str | None
    coach_display_name: str | None
    review_type: str  # 'clip' | 'session'


class RateReviewRequest(BaseModel):
    rating: int  # 1-5


# --- Routes ---

@router.post("", response_model=ReviewResponse, status_code=status.HTTP_201_CREATED)
async def request_review(
    body: ReviewCreateRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Athlete requests a clip or session review from a coach. Deducts credits immediately."""
    if not body.clip_id and not body.session_id:
        raise HTTPException(status_code=400, detail="Either clip_id or session_id is required")

    athlete = await _require_user(clerk_user_id, db)

    # Resolve coach profile → coach user
    profile_result = await db.execute(
        select(CoachProfile).where(CoachProfile.id == uuid.UUID(body.coach_profile_id))
    )
    coach_profile = profile_result.scalar_one_or_none()
    if not coach_profile:
        raise HTTPException(status_code=404, detail="Coach not found")
    if coach_profile.moderation_status != "approved":
        raise HTTPException(status_code=400, detail="Coach is not accepting reviews")
    if not coach_profile.credit_rate:
        raise HTTPException(status_code=400, detail="Coach has not set a credit rate")

    coach_result = await db.execute(select(User).where(User.id == coach_profile.user_id))
    coach = coach_result.scalar_one_or_none()
    if not coach:
        raise HTTPException(status_code=404, detail="Coach user not found")

    # Resolve clip or session — must belong to athlete
    clip = None
    session_obj = None

    if body.clip_id:
        clip_result = await db.execute(
            select(Clip).where(
                Clip.id == uuid.UUID(body.clip_id),
                Clip.clerk_user_id == clerk_user_id,
            )
        )
        clip = clip_result.scalar_one_or_none()
        if not clip:
            raise HTTPException(status_code=404, detail="Clip not found")
    else:
        from models.session import Session as SessionModel
        session_result = await db.execute(
            select(SessionModel).where(
                SessionModel.id == uuid.UUID(body.session_id),
                SessionModel.clerk_user_id == clerk_user_id,
            )
        )
        session_obj = session_result.scalar_one_or_none()
        if not session_obj:
            raise HTTPException(status_code=404, detail="Session not found")

    credits_cost = coach_profile.credit_rate

    # Check athlete has enough credits
    if athlete.credits_balance < credits_cost:
        raise HTTPException(
            status_code=402,
            detail=f"Insufficient credits — need {credits_cost}, have {athlete.credits_balance}",
        )

    # Deduct credits from athlete
    athlete.credits_balance -= credits_cost
    tx = CreditTransaction(
        user_id=athlete.id,
        amount=-credits_cost,
        type="coach_review_spend",
    )
    db.add(tx)

    # Create review
    review = ClipReview(
        clip_id=clip.id if clip else None,
        session_id=session_obj.id if session_obj else None,
        coach_id=coach.id,
        athlete_id=athlete.id,
        credits_cost=credits_cost,
        athlete_note=body.athlete_note,
    )
    db.add(review)
    await db.commit()
    await db.refresh(review)

    # Update transaction reference
    tx.reference_id = review.id
    await db.commit()

    # Notify coach of new review request
    await create_notification(
        db,
        user_id=coach.id,
        type="review_requested",
        title="New review request",
        body=f"A clip has been submitted for your review{f': {body.athlete_note}' if body.athlete_note else ''}",
        reference_id=review.id,
        reference_type="review",
    )
    await db.commit()

    logger.info(f"Review request created: {review.id} (athlete={athlete.id}, coach={coach.id})")

    return _build_response(review, clip, session_obj, coach_profile)


@router.get("/me/athlete", response_model=list[ReviewResponse])
async def list_athlete_reviews(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all review requests submitted by the current athlete."""
    athlete = await _require_user(clerk_user_id, db)

    result = await db.execute(
        select(ClipReview)
        .where(ClipReview.athlete_id == athlete.id)
        .order_by(ClipReview.created_at.desc())
    )
    reviews = result.scalars().all()
    return [await _enrich_response(r, db) for r in reviews]


@router.get("/me/coach", response_model=list[ReviewResponse])
async def list_coach_reviews(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return all review requests assigned to the current coach."""
    coach = await _require_user(clerk_user_id, db)
    if coach.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")

    result = await db.execute(
        select(ClipReview)
        .where(ClipReview.coach_id == coach.id)
        .order_by(ClipReview.created_at.desc())
    )
    reviews = result.scalars().all()
    return [await _enrich_response(r, db) for r in reviews]


@router.patch("/{review_id}/start", response_model=ReviewResponse)
async def start_review(
    review_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Coach marks a review as in progress."""
    review = await _get_coach_review(review_id, clerk_user_id, db)
    if review.status != "pending":
        raise HTTPException(status_code=400, detail="Review is not in pending state")
    review.status = "in_review"

    # Notify athlete that coach started the review
    await create_notification(
        db,
        user_id=review.athlete_id,
        type="review_started",
        title="Coach started your review",
        body="Your clip is being reviewed. Comments will appear when complete.",
        reference_id=review.clip_id,
        reference_type="clip",
    )
    await db.commit()
    return await _enrich_response(review, db)


@router.patch("/{review_id}/complete", response_model=ReviewResponse)
async def complete_review(
    review_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Coach marks review complete. Transfers 80% of credits to coach."""
    review = await _get_coach_review(review_id, clerk_user_id, db)
    if review.status not in ("pending", "in_review"):
        raise HTTPException(status_code=400, detail="Review is already complete")

    # Credit coach 80% (platform keeps 20%)
    coach_result = await db.execute(select(User).where(User.id == review.coach_id))
    coach = coach_result.scalar_one_or_none()
    coach_earnings = int(review.credits_cost * 0.8)
    coach.credits_balance += coach_earnings

    tx = CreditTransaction(
        user_id=coach.id,
        amount=coach_earnings,
        type="coach_payout",
        reference_id=review.id,
    )
    db.add(tx)

    review.status = "complete"
    review.completed_at = datetime.now(timezone.utc)

    # Update coach avg_response_hours
    hours_taken = (review.completed_at - review.created_at).total_seconds() / 3600
    if coach_profile.avg_response_hours is None:
        coach_profile.avg_response_hours = round(hours_taken, 1)
    else:
        # Rolling average across all completed reviews
        total_reviews = coach_profile.review_count or 1
        coach_profile.avg_response_hours = round(
            (coach_profile.avg_response_hours * (total_reviews - 1) + hours_taken) / total_reviews, 1
        )

    # Notify athlete review is done
    await create_notification(
        db,
        user_id=review.athlete_id,
        type="review_complete",
        title="Your review is ready",
        body="Your coach has finished reviewing your clip. Check the comments.",
        reference_id=review.clip_id,
        reference_type="clip",
    )
    # Notify coach of credit payout
    await create_notification(
        db,
        user_id=coach.id,
        type="credits_received",
        title=f"{coach_earnings} credits earned",
        body="Your review is complete and credits have been added to your balance.",
        reference_id=review.id,
        reference_type="review",
    )
    await db.commit()

    logger.info(f"Review {review_id} complete — coach earned {coach_earnings} credits")
    return await _enrich_response(review, db)


@router.patch("/{review_id}/cancel", response_model=ReviewResponse)
async def cancel_review(
    review_id: uuid.UUID,
    body: dict,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Coach cancels a review (e.g. footage un-reviewable).
    Credits are automatically refunded to the athlete.
    """
    review = await _get_coach_review(review_id, clerk_user_id, db)
    if review.status not in ("pending", "in_review"):
        raise HTTPException(status_code=400, detail="Only pending or in-review reviews can be cancelled")

    cancel_reason = body.get("cancel_reason", "").strip() or None

    # Refund credits to athlete
    athlete_result = await db.execute(select(User).where(User.id == review.athlete_id))
    athlete = athlete_result.scalar_one_or_none()
    if athlete:
        athlete.credits_balance += review.credits_cost
        db.add(CreditTransaction(
            user_id=athlete.id,
            amount=review.credits_cost,
            type="refund",
            reference_id=review.id,
        ))

    review.status = "cancelled"

    # Notify athlete
    note = f" Reason: {cancel_reason}" if cancel_reason else ""
    await create_notification(
        db,
        user_id=review.athlete_id,
        type="review_cancelled",
        title="Review cancelled — credits refunded",
        body=f"{review.credits_cost} credits have been returned to your balance.{note}",
        reference_id=review.id,
        reference_type="review",
    )
    await db.commit()

    logger.info(f"Review {review_id} cancelled — {review.credits_cost} credits refunded to athlete {review.athlete_id}")
    return await _enrich_response(review, db)


@router.get("/{review_id}/clip-access")
async def get_review_clip(
    review_id: uuid.UUID,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Returns presigned clip URL for a coach to access an athlete's clip via a review.
    Used by the coach's PlayerPage view.
    """
    coach = await _require_user(clerk_user_id, db)

    review_result = await db.execute(
        select(ClipReview).where(
            ClipReview.id == review_id,
            ClipReview.coach_id == coach.id,
            ClipReview.status.in_(["pending", "in_review", "complete"]),
        )
    )
    review = review_result.scalar_one_or_none()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    # Session review — return session metadata, coach navigates to session page
    if review.session_id:
        from models.session import Session as SessionModel
        session_result = await db.execute(select(SessionModel).where(SessionModel.id == review.session_id))
        session_obj = session_result.scalar_one_or_none()
        return {
            "review_type": "session",
            "session_id": str(review.session_id),
            "session_label": session_obj.label if session_obj else None,
            "review_status": review.status,
        }

    # Clip review — return presigned URLs
    clip_result = await db.execute(select(Clip).where(Clip.id == review.clip_id))
    clip = clip_result.scalar_one_or_none()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    from models.job import Job
    job_result = await db.execute(select(Job).where(Job.clip_id == clip.id))
    job = job_result.scalar_one_or_none()

    return {
        "review_type": "clip",
        "clip_id": str(clip.id),
        "filename": clip.filename,
        "video_url": generate_presigned_download_url(clip.s3_key),
        "result_url": generate_presigned_download_url(job.result_s3_key) if job and job.result_s3_key else None,
        "thumbnail_url": generate_presigned_download_url(clip.thumbnail_s3_key) if clip.thumbnail_s3_key else None,
        "review_status": review.status,
    }


@router.patch("/{review_id}/rate", response_model=ReviewResponse)
async def rate_review(
    review_id: uuid.UUID,
    body: RateReviewRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Athlete submits a 1-5 star rating after a review is complete."""
    if not 1 <= body.rating <= 5:
        raise HTTPException(status_code=400, detail="Rating must be between 1 and 5")

    athlete = await _require_user(clerk_user_id, db)

    review_result = await db.execute(
        select(ClipReview).where(
            ClipReview.id == review_id,
            ClipReview.athlete_id == athlete.id,
            ClipReview.status == "complete",
        )
    )
    review = review_result.scalar_one_or_none()
    if not review:
        raise HTTPException(status_code=404, detail="Completed review not found")

    if review.athlete_rating is not None:
        raise HTTPException(status_code=409, detail="Review already rated")

    review.athlete_rating = body.rating

    # Recompute coach aggregate rating
    coach_profile_result = await db.execute(
        select(CoachProfile).where(CoachProfile.user_id == review.coach_id)
    )
    coach_profile = coach_profile_result.scalar_one_or_none()
    if coach_profile:
        # Fetch all rated reviews for this coach
        all_ratings_result = await db.execute(
            select(ClipReview.athlete_rating).where(
                ClipReview.coach_id == review.coach_id,
                ClipReview.athlete_rating.is_not(None),
            )
        )
        existing_ratings = [r[0] for r in all_ratings_result]
        all_ratings = existing_ratings + [body.rating]
        coach_profile.rating = round(sum(all_ratings) / len(all_ratings), 2)
        coach_profile.review_count = len(all_ratings)

    await db.commit()
    logger.info(f"Review {review_id} rated {body.rating}/5 by athlete {athlete.id}")
    return await _enrich_response(review, db)


# --- Helpers ---

async def _require_user(clerk_user_id: str, db: AsyncSession) -> User:
    result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


async def _get_coach_review(review_id: uuid.UUID, clerk_user_id: str, db: AsyncSession) -> ClipReview:
    coach = await _require_user(clerk_user_id, db)
    if coach.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")

    result = await db.execute(
        select(ClipReview).where(
            ClipReview.id == review_id,
            ClipReview.coach_id == coach.id,
        )
    )
    review = result.scalar_one_or_none()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    return review


def _build_response(review: ClipReview, clip, session_obj, coach_profile: CoachProfile | None) -> ReviewResponse:
    is_session = review.session_id is not None
    return ReviewResponse(
        id=str(review.id),
        clip_id=str(review.clip_id) if review.clip_id else None,
        coach_id=str(review.coach_id),
        athlete_id=str(review.athlete_id),
        status=review.status,
        credits_cost=review.credits_cost,
        athlete_note=review.athlete_note,
        athlete_rating=review.athlete_rating,
        created_at=review.created_at,
        completed_at=review.completed_at,
        clip_thumbnail_url=generate_presigned_download_url(clip.thumbnail_s3_key) if clip and clip.thumbnail_s3_key else None,
        clip_filename=clip.filename if clip else None,
        session_id=str(review.session_id) if review.session_id else None,
        session_label=session_obj.label if session_obj else None,
        coach_display_name=coach_profile.display_name if coach_profile else None,
        review_type="session" if is_session else "clip",
    )


async def _enrich_response(review: ClipReview, db: AsyncSession) -> ReviewResponse:
    from models.session import Session as SessionModel

    clip = None
    if review.clip_id:
        clip_result = await db.execute(select(Clip).where(Clip.id == review.clip_id))
        clip = clip_result.scalar_one_or_none()

    session_obj = None
    if review.session_id:
        session_result = await db.execute(select(SessionModel).where(SessionModel.id == review.session_id))
        session_obj = session_result.scalar_one_or_none()

    coach_profile = None
    profile_result = await db.execute(
        select(CoachProfile).where(CoachProfile.user_id == review.coach_id)
    )
    coach_profile = profile_result.scalar_one_or_none()

    return _build_response(review, clip, session_obj, coach_profile)
