import logging
import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from dependencies import get_current_user
from db.session import get_db
from models.user import User
from models.credit_transaction import CreditTransaction
from models.coach_profile import CoachProfile

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/payments", tags=["payments"])

# Credit packs — add more or adjust pricing here
# Tier definitions
TIER_CONFIG = {
    "free":  {"clips_per_month": 3,    "monthly_credits": 5},
    "pro":   {"clips_per_month": None, "monthly_credits": 25},   # None = unlimited
    "elite": {"clips_per_month": None, "monthly_credits": 75},
}

PRICE_TO_TIER = {}  # populated at request time from settings

def _get_price_to_tier():
    return {
        settings.STRIPE_PRO_PRICE_ID:   "pro",
        settings.STRIPE_ELITE_PRICE_ID: "elite",
    }

CREDIT_PACKS = {
    "starter": {"credits": 10,  "price_cents": 499,  "label": "10 Credits",  "description": "Perfect for trying out a coach review"},
    "pro":     {"credits": 30,  "price_cents": 999,  "label": "30 Credits",  "description": "Best value for regular coaching"},
    "elite":   {"credits": 75,  "price_cents": 1999, "label": "75 Credits",  "description": "For serious athletes"},
}

FRONTEND_URL = "http://localhost:5173"

# Stripe Connect — credits to dollars conversion rate for coach payouts
CREDIT_PAYOUT_RATE_CENTS = 25   # 1 credit = $0.25
MINIMUM_PAYOUT_CREDITS = 50     # $12.50 minimum to cover Stripe fees


class CheckoutRequest(BaseModel):
    pack: str  # starter | pro | elite


@router.get("/packs")
def list_packs():
    """Return available credit packs."""
    return [
        {
            "id": pack_id,
            "credits": pack["credits"],
            "price_cents": pack["price_cents"],
            "label": pack["label"],
            "description": pack["description"],
        }
        for pack_id, pack in CREDIT_PACKS.items()
    ]


@router.post("/checkout")
async def create_checkout(
    body: CheckoutRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a Stripe Checkout session for a credit pack purchase."""
    pack = CREDIT_PACKS.get(body.pack)
    if not pack:
        raise HTTPException(status_code=400, detail=f"Invalid pack: {body.pack}")

    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{
                "price_data": {
                    "currency": "usd",
                    "product_data": {
                        "name": f"Southpaw — {pack['label']}",
                        "description": pack["description"],
                    },
                    "unit_amount": pack["price_cents"],
                },
                "quantity": 1,
            }],
            mode="payment",
            success_url=f"{FRONTEND_URL}/dashboard?payment=success&pack={body.pack}",
            cancel_url=f"{FRONTEND_URL}/dashboard?payment=cancelled",
            metadata={
                "clerk_user_id": clerk_user_id,
                "user_id": str(user.id),
                "pack": body.pack,
                "credits": str(pack["credits"]),
            },
        )
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logger.error(f"Stripe error: {e}")
        raise HTTPException(status_code=502, detail="Failed to create checkout session")


@router.get("/tiers")
def list_tiers():
    """Return tier config for the pricing page."""
    return [
        {
            "id": "free",
            "name": "Free",
            "price_monthly": 0,
            "clips_per_month": TIER_CONFIG["free"]["clips_per_month"],
            "monthly_credits": TIER_CONFIG["free"]["monthly_credits"],
            "features": ["3 clips/month", "5 credits/month", "Clip-level AI feedback"],
        },
        {
            "id": "pro",
            "name": "Pro",
            "price_monthly": 12,
            "clips_per_month": None,
            "monthly_credits": TIER_CONFIG["pro"]["monthly_credits"],
            "features": ["Unlimited clips", "25 credits/month", "Session & trend feedback", "Combo detection"],
        },
        {
            "id": "elite",
            "name": "Elite",
            "price_monthly": 29,
            "clips_per_month": None,
            "monthly_credits": TIER_CONFIG["elite"]["monthly_credits"],
            "features": ["Unlimited clips", "75 credits/month", "All Pro features", "Priority processing"],
        },
    ]


@router.post("/subscribe")
async def create_subscription_checkout(
    body: CheckoutRequest,
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a Stripe Checkout session for a subscription plan."""
    price_id = None
    if body.pack == "pro":
        price_id = settings.STRIPE_PRO_PRICE_ID
    elif body.pack == "elite":
        price_id = settings.STRIPE_ELITE_PRICE_ID
    else:
        raise HTTPException(status_code=400, detail="Invalid plan — use pro or elite")

    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    # Create or retrieve Stripe customer
    if not user.stripe_customer_id:
        customer = stripe.Customer.create(metadata={"clerk_user_id": clerk_user_id})
        user.stripe_customer_id = customer.id
        await db.commit()

    try:
        session = stripe.checkout.Session.create(
            customer=user.stripe_customer_id,
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            success_url=f"{FRONTEND_URL}/dashboard?subscription=success",
            cancel_url=f"{FRONTEND_URL}/pricing?subscription=cancelled",
            metadata={"clerk_user_id": clerk_user_id},
        )
        return {"checkout_url": session.url}
    except stripe.StripeError as e:
        logger.error(f"Stripe subscription error: {e}")
        raise HTTPException(status_code=502, detail="Failed to create checkout session")


@router.post("/portal")
async def create_customer_portal(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return a Stripe Customer Portal URL for managing/cancelling subscriptions."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user or not user.stripe_customer_id:
        raise HTTPException(status_code=400, detail="No subscription found")

    stripe.api_key = settings.STRIPE_SECRET_KEY
    session = stripe.billing_portal.Session.create(
        customer=user.stripe_customer_id,
        return_url=f"{FRONTEND_URL}/dashboard",
    )
    return {"portal_url": session.url}


@router.post("/connect/onboard")
async def connect_onboard(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Create (or retrieve) a Stripe Express account for a coach and return
    a hosted onboarding URL. Coach completes KYC on Stripe's page.
    """
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user or user.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")

    profile_result = await db.execute(select(CoachProfile).where(CoachProfile.user_id == user.id))
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    # Create Express account if not already linked
    if not profile.stripe_account_id:
        account = stripe.Account.create(type="express")
        profile.stripe_account_id = account.id
        await db.commit()

    # Generate fresh onboarding link
    account_link = stripe.AccountLink.create(
        account=profile.stripe_account_id,
        refresh_url=f"{FRONTEND_URL}/coach/profile?connect=refresh",
        return_url=f"{FRONTEND_URL}/coach/profile?connect=success",
        type="account_onboarding",
    )
    return {"onboarding_url": account_link.url}


@router.get("/connect/status")
async def connect_status(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return the coach's Connect status and payout eligibility."""
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user or user.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")

    profile_result = await db.execute(select(CoachProfile).where(CoachProfile.user_id == user.id))
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")

    return {
        "stripe_connected": bool(profile.stripe_account_id),
        "payouts_enabled": profile.stripe_payouts_enabled,
        "credits_balance": user.credits_balance,
        "minimum_payout_credits": MINIMUM_PAYOUT_CREDITS,
        "payout_value_dollars": round(user.credits_balance * CREDIT_PAYOUT_RATE_CENTS / 100, 2),
        "can_payout": profile.stripe_payouts_enabled and user.credits_balance >= MINIMUM_PAYOUT_CREDITS,
    }


@router.post("/connect/payout")
async def connect_payout(
    clerk_user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Convert coach credits to dollars and transfer via Stripe Connect.
    Pays out the full credit balance (above minimum threshold).
    """
    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user or user.user_type != "coach":
        raise HTTPException(status_code=403, detail="Coach access required")

    profile_result = await db.execute(select(CoachProfile).where(CoachProfile.user_id == user.id))
    profile = profile_result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Coach profile not found")

    if not profile.stripe_payouts_enabled:
        raise HTTPException(status_code=400, detail="Stripe account not fully set up — complete onboarding first")

    if user.credits_balance < MINIMUM_PAYOUT_CREDITS:
        raise HTTPException(
            status_code=400,
            detail=f"Minimum payout is {MINIMUM_PAYOUT_CREDITS} credits (${MINIMUM_PAYOUT_CREDITS * CREDIT_PAYOUT_RATE_CENTS / 100:.2f})"
        )

    credits_to_pay = user.credits_balance
    amount_cents = credits_to_pay * CREDIT_PAYOUT_RATE_CENTS

    stripe.api_key = settings.STRIPE_SECRET_KEY

    try:
        transfer = stripe.Transfer.create(
            amount=amount_cents,
            currency="usd",
            destination=profile.stripe_account_id,
            description=f"Southpaw coach payout — {credits_to_pay} credits",
        )
    except stripe.StripeError as e:
        logger.error(f"Stripe transfer failed for coach {user.id}: {e}")
        raise HTTPException(status_code=502, detail="Payout failed — please try again")

    # Deduct credits and record transaction
    user.credits_balance = 0
    db.add(CreditTransaction(
        user_id=user.id,
        amount=-credits_to_pay,
        type="coach_payout",
    ))
    await db.commit()

    logger.info(f"Paid out {credits_to_pay} credits (${amount_cents/100:.2f}) to coach {user.id} (transfer {transfer.id})")
    return {
        "credits_paid": credits_to_pay,
        "amount_dollars": amount_cents / 100,
        "transfer_id": transfer.id,
    }


@router.post("/webhook")
async def stripe_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Handle Stripe webhook events.
    Currently handles: checkout.session.completed
    """
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    stripe.api_key = settings.STRIPE_SECRET_KEY

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
        )
    except stripe.SignatureVerificationError:
        raise HTTPException(status_code=400, detail="Invalid webhook signature")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

    if event["type"] == "checkout.session.completed":
        await _handle_checkout_complete(event["data"]["object"], db)
    elif event["type"] in ("customer.subscription.created", "customer.subscription.updated"):
        await _handle_subscription_change(event["data"]["object"], db)
    elif event["type"] == "customer.subscription.deleted":
        await _handle_subscription_deleted(event["data"]["object"], db)
    elif event["type"] == "invoice.payment_succeeded":
        await _handle_invoice_paid(event["data"]["object"], db)
    elif event["type"] == "account.updated":
        await _handle_account_updated(event["data"]["object"], db)
    else:
        logger.info(f"Unhandled Stripe event: {event['type']}")

    return {"status": "ok"}


async def _handle_checkout_complete(session: dict, db: AsyncSession):
    """Credit the user after a successful Stripe Checkout payment."""
    metadata = session.get("metadata", {})
    clerk_user_id = metadata.get("clerk_user_id")
    pack_id = metadata.get("pack")
    credits_str = metadata.get("credits")

    if not clerk_user_id or not pack_id or not credits_str:
        logger.warning(f"Missing metadata on checkout session {session.get('id')}")
        return

    credits = int(credits_str)
    stripe_session_id = session.get("id")

    # Idempotency — don't double-credit if webhook fires twice
    existing = await db.execute(
        select(CreditTransaction).where(
            CreditTransaction.type == "purchase",
            CreditTransaction.reference_id.cast(str) == stripe_session_id,
        )
    )
    if existing.scalar_one_or_none():
        logger.info(f"Duplicate webhook for session {stripe_session_id} — skipping")
        return

    user_result = await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        logger.error(f"User not found for clerk_user_id={clerk_user_id}")
        return

    user.credits_balance += credits
    tx = CreditTransaction(
        user_id=user.id,
        amount=credits,
        type="purchase",
    )
    db.add(tx)
    await db.commit()

    logger.info(f"Credited {credits} to user {clerk_user_id} (pack={pack_id}, session={stripe_session_id})")


async def _handle_subscription_change(subscription, db: AsyncSession):
    """Update user tier when subscription is created or changed."""
    customer_id = subscription["customer"]
    price_id = subscription["items"]["data"][0]["price"]["id"]
    tier = _get_price_to_tier().get(price_id, "free")

    user_result = await db.execute(select(User).where(User.stripe_customer_id == customer_id))
    user = user_result.scalar_one_or_none()
    if not user:
        logger.warning(f"No user found for Stripe customer {customer_id}")
        return

    user.subscription_tier = tier
    await db.commit()
    logger.info(f"Updated subscription tier to '{tier}' for user {user.id}")


async def _handle_subscription_deleted(subscription, db: AsyncSession):
    """Downgrade to free when subscription is cancelled."""
    customer_id = subscription["customer"]
    user_result = await db.execute(select(User).where(User.stripe_customer_id == customer_id))
    user = user_result.scalar_one_or_none()
    if not user:
        return
    user.subscription_tier = "free"
    await db.commit()
    logger.info(f"Downgraded user {user.id} to free tier")


async def _handle_invoice_paid(invoice, db: AsyncSession):
    """Grant monthly credits when subscription invoice is paid."""
    customer_id = invoice["customer"]
    # Only process subscription invoices (not one-time charges)
    if not invoice.get("subscription"):
        return

    user_result = await db.execute(select(User).where(User.stripe_customer_id == customer_id))
    user = user_result.scalar_one_or_none()
    if not user:
        return

    monthly_credits = TIER_CONFIG.get(user.subscription_tier, {}).get("monthly_credits", 0)
    if monthly_credits > 0:
        user.credits_balance += monthly_credits
        db.add(CreditTransaction(
            user_id=user.id,
            amount=monthly_credits,
            type="subscription_grant",
        ))
        await db.commit()
        logger.info(f"Granted {monthly_credits} credits to user {user.id} ({user.subscription_tier} tier)")


async def _handle_account_updated(account, db: AsyncSession):
    """Mark payouts_enabled on the coach profile when Stripe KYC is complete."""
    account_id = account["id"] if "id" in account else None
    payouts_enabled = account["payouts_enabled"] if "payouts_enabled" in account else False

    if not account_id:
        return

    profile_result = await db.execute(
        select(CoachProfile).where(CoachProfile.stripe_account_id == account_id)
    )
    profile = profile_result.scalar_one_or_none()
    if not profile:
        logger.info(f"No coach profile found for Stripe account {account_id}")
        return

    if profile.stripe_payouts_enabled != payouts_enabled:
        profile.stripe_payouts_enabled = payouts_enabled
        await db.commit()
        logger.info(f"Updated payouts_enabled={payouts_enabled} for coach profile {profile.id}")
