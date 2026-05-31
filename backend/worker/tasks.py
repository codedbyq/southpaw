import logging
from celery import current_task
from sqlalchemy import select
from worker.celery_app import celery_app
from worker.db import get_sync_session
from models.job import Job

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, max_retries=3)
def process_clip(self, clip_id: str, job_id: str):
    """
    Main video processing task.
    bind=True gives us access to self for retries and task metadata.
    max_retries=3 means Celery will retry up to 3 times on failure.
    """
    logger.info(f"Starting processing for clip {clip_id}, job {job_id}")

    with get_sync_session() as db:
        # Fetch the job
        job = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()

        if job is None:
            logger.error(f"Job {job_id} not found")
            return

        try:
            # Mark job as started
            job.status = "processing"
            job.progress = 0
            db.commit()

            # TODO: Step 1 — download clip from S3
            # TODO: Step 2 — run MediaPipe frame by frame
            # TODO: Step 3 — classify strikes
            # TODO: Step 4 — write keypoint JSON to S3
            # TODO: Step 5 — write strike rows to Postgres
            # TODO: Step 6 — publish SSE progress events to Redis pub/sub

            # Stub — simulate completion for now
            job.status = "complete"
            job.progress = 100
            db.commit()

            logger.info(f"Job {job_id} complete")

        except Exception as exc:
            job.status = "failed"
            job.error = str(exc)
            db.commit()
            logger.error(f"Job {job_id} failed: {exc}")
            raise self.retry(exc=exc, countdown=10)