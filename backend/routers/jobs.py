import json
import asyncio
import redis.asyncio as aioredis
import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.config import settings
from db.session import get_db
from dependencies import get_current_user
from models.job import Job
from models.clip import Clip

router = APIRouter(prefix="/jobs", tags=["jobs"])

# JWKS client — fetches Clerk's public keys once and caches them
_jwks_client = None

def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            f"https://{settings.CLERK_FRONTEND_API}/.well-known/jwks.json"
        )
    return _jwks_client


async def _get_user_from_token(token: str = Query(...)) -> str:
    """
    Verify a Clerk JWT passed as a query param.
    Used for SSE since EventSource doesn't support custom headers.
    """
    try:
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        payload = pyjwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            options={"verify_exp": True},
        )
        return payload["sub"]
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token"
        )


@router.get("/{job_id}")
async def get_job(
    job_id: str,
    user_id: str = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Poll job status — used when user returns after closing tab."""
    job = await _get_job_for_user(job_id, user_id, db)
    return {
        "id": str(job.id),
        "status": job.status,
        "progress": job.progress,
        "result_s3_key": job.result_s3_key,
        "error": job.error,
    }


@router.get("/{job_id}/stream")
async def stream_job(
    job_id: str,
    user_id: str = Depends(_get_user_from_token),
    db: AsyncSession = Depends(get_db),
):
    """
    SSE endpoint — streams progress events until job is complete or failed.
    Auth via query param token since EventSource doesn't support headers.
    """
    job = await _get_job_for_user(job_id, user_id, db)

    # Job already finished — send final event immediately and close
    if job.status in ("complete", "failed"):
        async def already_done():
            payload = json.dumps({
                "status": job.status,
                "progress": job.progress
            })
            yield f"data: {payload}\n\n"
        return StreamingResponse(already_done(), media_type="text/event-stream")

    return StreamingResponse(
        _event_generator(job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


async def _event_generator(job_id: str):
    """Subscribe to Redis pub/sub channel and forward events to browser."""
    redis = aioredis.from_url(settings.REDIS_URL)
    pubsub = redis.pubsub()
    await pubsub.subscribe(f"job:{job_id}")

    try:
        # Initial heartbeat so browser knows connection is open
        yield "data: {\"status\": \"connected\"}\n\n"

        async for message in pubsub.listen():
            if message["type"] != "message":
                continue

            data = message["data"]
            if isinstance(data, bytes):
                data = data.decode("utf-8")

            yield f"data: {data}\n\n"

            parsed = json.loads(data)
            if parsed.get("status") in ("complete", "failed"):
                break

            await asyncio.sleep(0.01)

    finally:
        await pubsub.unsubscribe(f"job:{job_id}")
        await redis.aclose()


async def _get_job_for_user(job_id: str, user_id: str, db: AsyncSession) -> Job:
    """Fetch job and verify ownership through clips table."""
    result = await db.execute(
        select(Job)
        .join(Clip, Job.clip_id == Clip.id)
        .where(
            Job.id == job_id,
            Clip.clerk_user_id == user_id,
        )
    )
    job = result.scalar_one_or_none()
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Job not found"
        )
    return job