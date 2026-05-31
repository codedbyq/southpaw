from celery import Celery
from core.config import settings

celery_app = Celery(
    "southpaw",
    broker=settings.REDIS_URL,
    backend=settings.REDIS_URL,
    include=["worker.tasks"],
)

celery_app.conf.update(
    task_track_started=True,       # job status goes 'started' before 'processing'
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
)