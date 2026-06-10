"""
Admin reprocessing: re-run Modal inference for existing clips.

Safe to run repeatedly — run_inference is idempotent (wipes its own strike
rows at start) and stamps pipeline_version, so reprocessed clips are
distinguishable from old ones. Use after a classifier/model upgrade to bring
beta clips onto the new pipeline.

Usage (from backend/, with .env loaded):
    python scripts/reprocess_clip.py <clip_id> [<clip_id> ...]
    python scripts/reprocess_clip.py --all-before-version v3   # every clip whose
                                                               # pipeline_version doesn't start with v3
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import modal
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import sessionmaker

from core.config import settings
from models.clip import Clip
from models.job import Job
from models.user import User


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)

    engine = create_engine(
        settings.DATABASE_URL.replace("+asyncpg", ""),
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )
    Session = sessionmaker(bind=engine)

    run_inference = modal.Function.from_name(
        "southpaw-inference", "run_inference",
        environment_name=settings.MODAL_ENVIRONMENT or None,
    )

    with Session() as db:
        if args[0] == "--all-before-version":
            prefix = args[1]
            clip_ids = [
                str(row[0]) for row in db.execute(text(
                    "SELECT id FROM clips WHERE status = 'uploaded' "
                    "AND (pipeline_version IS NULL OR pipeline_version NOT LIKE :p)"
                ), {"p": f"{prefix}%"}).fetchall()
            ]
            print(f"{len(clip_ids)} clips on pre-{prefix} pipeline")
        else:
            clip_ids = args

        for clip_id in clip_ids:
            clip = db.execute(select(Clip).where(Clip.id == clip_id)).scalar_one_or_none()
            if clip is None:
                print(f"  ! {clip_id}: not found, skipped")
                continue
            job = db.execute(select(Job).where(Job.clip_id == clip.id)).scalar_one_or_none()
            if job is None:
                job = Job(clip_id=clip.id)
                db.add(job)
            job.status = "queued"
            job.progress = 0
            job.error = None
            job.error_code = None
            db.commit()

            user = db.execute(
                select(User).where(User.clerk_user_id == clip.clerk_user_id)
            ).scalar_one_or_none()
            tier = user.subscription_tier if user else "free"

            run_inference.spawn(
                clip_id=str(clip.id),
                job_id=str(job.id),
                s3_key=clip.s3_key,
                tier=tier,
            )
            print(f"  ✓ {clip_id}: respawned (job {job.id}, tier {tier})")


if __name__ == "__main__":
    main()
