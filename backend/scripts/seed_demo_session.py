"""Seed the demo account with a stable session fixture for UI verification.

Creates one bag-work session with two completed clips and a realistic strike
pattern (jab-cross heavy, some variety) so session analytics — predictability,
fatigue curve, guard breakdown, combos — all render. Re-running replaces the
previous fixture (matched by label).

Usage:  cd backend && ./venv/bin/python scripts/seed_demo_session.py
"""

import asyncio
import os
import random
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

FIXTURE_LABEL = "Demo: bag work (seeded fixture)"

POWER_TYPES = ["cross", "lead_hook", "rear_uppercut"]


def _gen_strikes(rng: random.Random, duration: int) -> list[dict]:
    """Realistic bag round: ~60% 1-2s, the rest mixed 3-strike combos."""
    strikes, t = [], 5.0
    while t < duration - 10:
        if rng.random() < 0.6:
            combo = ["jab", "cross"]
        else:
            combo = ["jab"] + rng.sample(POWER_TYPES, 2)
        for i, st in enumerate(combo):
            ts = t + i * rng.uniform(0.35, 0.6)
            strikes.append({
                "type": st,
                "timestamp_seconds": round(ts, 2),
                "frame_index": int(ts * 30),
                "confidence": round(rng.uniform(0.7, 0.95), 2),
                "arm_extension": round(rng.gauss(0.8, 0.06), 3),
                "guard_dropped": rng.random() < (0.45 if st != "jab" else 0.2),
            })
        t += rng.uniform(4.5, 8.0)
    return strikes


async def main():
    eng = create_async_engine(os.environ["DATABASE_URL"])
    demo_uid = os.environ["DEMO_CLERK_USER_ID"]
    rng = random.Random(42)
    now = datetime.now(timezone.utc)

    async with eng.begin() as conn:
        # Replace any previous fixture (clip/job/strike rows cascade)
        old = (await conn.execute(text(
            "select id from sessions where clerk_user_id = :u and label = :l"),
            {"u": demo_uid, "l": FIXTURE_LABEL})).fetchall()
        for (sid,) in old:
            await conn.execute(text("delete from clips where session_id = :s"), {"s": sid})
            await conn.execute(text("delete from sessions where id = :s"), {"s": sid})

        session_id = uuid.uuid4()
        await conn.execute(text(
            "insert into sessions (id, clerk_user_id, label, sport, session_type, notes, training_phase, llm_summary_dirty, created_at) "
            "values (:id, :u, :l, 'boxing', 'bag', 'Seeded demo fixture — stable data for UI states.', 'regular', true, :now)"),
            {"id": session_id, "u": demo_uid, "l": FIXTURE_LABEL, "now": now})

        for n, (head, quality) in enumerate([(0.35, 0.82), (0.42, 0.78)], start=1):
            clip_id, job_id = uuid.uuid4(), uuid.uuid4()
            await conn.execute(text(
                "insert into clips (id, clerk_user_id, s3_key, filename, duration_seconds, status, sport, session_id, "
                "stance, head_movement_score, subject_confidence, pose_quality_score, clip_type, created_at) "
                "values (:id, :u, :s3, :fn, 180, 'complete', 'boxing', :sid, "
                "'orthodox', :head, 0.9, :quality, 'bag', :now)"),
                {"id": clip_id, "u": demo_uid, "s3": f"demo/seed/bag-round-{n}.mp4",
                 "fn": f"bag-round-{n}.mp4", "sid": session_id, "head": head, "quality": quality, "now": now})
            # live jobs table has no created_at column (schema drift vs the model)
            await conn.execute(text(
                "insert into jobs (id, clip_id, status, progress, attempt, started_at, completed_at) "
                "values (:id, :cid, 'complete', 100, 1, :now, :now)"),
                {"id": job_id, "cid": clip_id, "now": now})

            for s in _gen_strikes(rng, 180):
                await conn.execute(text(
                    "insert into strikes (id, job_id, type, timestamp_seconds, frame_index, subject_id, confidence, arm_extension, guard_dropped) "
                    "values (:id, :jid, :type, :ts, :fi, 0, :conf, :ext, :gd)"),
                    {"id": uuid.uuid4(), "jid": job_id, "type": s["type"], "ts": s["timestamp_seconds"],
                     "fi": s["frame_index"], "conf": s["confidence"], "ext": s["arm_extension"], "gd": s["guard_dropped"]})

        print(f"Seeded session {session_id} ('{FIXTURE_LABEL}') with 2 clips for {demo_uid}")

    await eng.dispose()


if __name__ == "__main__":
    asyncio.run(main())
