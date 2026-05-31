import logging
import json
import tempfile
import os
from celery import current_task
from sqlalchemy import select
import cv2
import boto3
from ultralytics import YOLO
import numpy as np
from worker.celery_app import celery_app
from worker.db import get_sync_session
from models.job import Job
from models.clip import Clip
from models.strike import Strike
from core.config import settings

logger = logging.getLogger(__name__)

# Load YOLOv8 pose model once at module level
# Downloads automatically on first run (~6MB)
model = YOLO("yolov8n-pose.pt")  # n = nano, fastest version, good for MVP

# S3 client for the worker
s3 = boto3.client(
    "s3",
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    region_name=settings.AWS_REGION,
)

# How many consecutive frames we look back to calculate velocity
VELOCITY_WINDOW = 5

# Minimum wrist/ankle velocity (normalized 0-1 units per frame) to count as a strike
STRIKE_VELOCITY_THRESHOLD = 0.02

# Minimum frames between detected strikes to avoid double-counting
STRIKE_COOLDOWN_FRAMES = 15


@celery_app.task(bind=True, max_retries=3)
def process_clip(self, clip_id: str, job_id: str):
    logger.info(f"Starting processing for clip {clip_id}, job {job_id}")

    with get_sync_session() as db:
        job = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()
        clip = db.execute(select(Clip).where(Clip.id == clip_id)).scalar_one_or_none()

        if not job or not clip:
            logger.error(f"Job or clip not found: job={job_id} clip={clip_id}")
            return

        try:
            job.status = "processing"
            job.progress = 0
            db.commit()

            # Step 1 — download clip from S3 to a temp file
            tmp_path = _download_clip(clip.s3_key)
            logger.info(f"Downloaded clip to {tmp_path}")

            # Step 2 — run MediaPipe frame by frame
            frames_data, strikes_data, total_frames = _process_video(
                tmp_path, job_id, job, db
            )

            # Step 3 — write keypoint JSON to S3
            result_s3_key = f"processed/{clip.clerk_user_id}/{clip_id}/keypoints.json"
            _write_results_to_s3(result_s3_key, {
                "clip_id": clip_id,
                "total_frames": total_frames,
                "frames": frames_data,
            })
            logger.info(f"Wrote keypoint JSON to S3: {result_s3_key}")

            # Step 4 — write strike rows to Postgres
            for strike in strikes_data:
                db.add(Strike(
                    job_id=job.id,
                    type=strike["type"],
                    timestamp_seconds=strike["timestamp_seconds"],
                    frame_index=strike["frame_index"],
                    confidence=None,  # rules-based has no confidence score
                ))
            db.commit()
            logger.info(f"Wrote {len(strikes_data)} strikes to Postgres")

            # Step 5 — mark job complete
            job.status = "complete"
            job.progress = 100
            job.result_s3_key = result_s3_key
            db.commit()

            logger.info(f"Job {job_id} complete — {len(strikes_data)} strikes detected")

        except Exception as exc:
            logger.error(f"Job {job_id} failed: {exc}")
            job.status = "failed"
            job.error = str(exc)
            db.commit()
            raise self.retry(exc=exc, countdown=10)

        finally:
            # Always clean up the temp file
            if 'tmp_path' in locals() and os.path.exists(tmp_path):
                os.remove(tmp_path)


def _download_clip(s3_key: str) -> str:
    """Download clip from S3 to a temp file. Returns the local file path."""
    suffix = os.path.splitext(s3_key)[-1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    s3.download_fileobj(settings.S3_BUCKET_NAME, s3_key, tmp)
    tmp.close()
    return tmp.name


def _process_video(tmp_path: str, job_id: str, job, db) -> tuple:
    cap = cv2.VideoCapture(tmp_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30

    frames_data = []
    strikes_data = []
    keypoint_history = {}
    last_strike_frame = {}
    frame_index = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        # Run YOLOv8 pose on the frame
        results = model(frame, verbose=False)

        timestamp = frame_index / fps
        frame_strikes = []
        skeletons = []

        for subject_idx, result in enumerate(results):
            if result.keypoints is None:
                continue

            kps = result.keypoints.xy[0].cpu().numpy()     # (17, 2) x/y pixel coords
            conf = result.keypoints.conf[0].cpu().numpy()  # (17,) confidence per keypoint

            h, w = frame.shape[:2]

            # Normalize to 0-1 to match our schema
            keypoints = [
                {
                    "x": float(kps[i][0] / w),
                    "y": float(kps[i][1] / h),
                    "visibility": float(conf[i]),
                }
                for i in range(len(kps))
            ]
            skeletons.append({"id": subject_idx, "keypoints": keypoints})

            # Update history for this subject
            if subject_idx not in keypoint_history:
                keypoint_history[subject_idx] = []
            keypoint_history[subject_idx].append(keypoints)
            if len(keypoint_history[subject_idx]) > VELOCITY_WINDOW:
                keypoint_history[subject_idx].pop(0)

            if len(keypoint_history[subject_idx]) >= VELOCITY_WINDOW:
                strike = _classify_strike(
                    keypoint_history[subject_idx],
                    frame_index,
                    last_strike_frame.get(subject_idx, -STRIKE_COOLDOWN_FRAMES),
                )
                if strike:
                    strike["timestamp_seconds"] = timestamp
                    strike["frame_index"] = frame_index
                    frame_strikes.append(strike)
                    strikes_data.append(strike)
                    last_strike_frame[subject_idx] = frame_index

        frames_data.append({
            "frame": frame_index,
            "timestamp": round(timestamp, 4),
            "skeletons": skeletons,
            "strikes": frame_strikes,
        })

        if frame_index % 30 == 0 and total_frames > 0:
            progress = min(int((frame_index / total_frames) * 95), 95)
            job.progress = progress
            db.commit()
            logger.info(f"Job {job_id} progress: {progress}%")

        frame_index += 1

    cap.release()
    return frames_data, strikes_data, frame_index


# COCO 17 keypoint indices (replace in _classify_strike):
# 9  = left wrist   10 = right wrist
# 15 = left ankle   16 = right ankle
# 7  = left elbow   8  = right elbow

def _classify_strike(history, current_frame, last_strike_frame):
    if current_frame - last_strike_frame < STRIKE_COOLDOWN_FRAMES:
        return None

    current = history[-1]
    past = history[0]

    def velocity(idx):
        dx = current[idx]["x"] - past[idx]["x"]
        dy = current[idx]["y"] - past[idx]["y"]
        return (dx**2 + dy**2) ** 0.5, dx, dy

    lw_vel, lw_dx, lw_dy = velocity(9)   # left wrist
    rw_vel, rw_dx, rw_dy = velocity(10)  # right wrist
    la_vel, la_dx, la_dy = velocity(15)  # left ankle
    ra_vel, ra_dx, ra_dy = velocity(16)  # right ankle

    left_elbow_x  = current[7]["x"]
    left_wrist_x  = current[9]["x"]
    right_elbow_x = current[8]["x"]
    right_wrist_x = current[10]["x"]

    left_hook_shape  = abs(left_wrist_x  - left_elbow_x)  < 0.1
    right_hook_shape = abs(right_wrist_x - right_elbow_x) < 0.1

    if rw_vel > STRIKE_VELOCITY_THRESHOLD and abs(rw_dx) > abs(rw_dy):
        return {"type": "hook"} if right_hook_shape else {"type": "jab"}

    if lw_vel > STRIKE_VELOCITY_THRESHOLD and abs(lw_dx) > abs(lw_dy):
        return {"type": "hook"} if left_hook_shape else {"type": "cross"}

    if ra_vel > STRIKE_VELOCITY_THRESHOLD and ra_dy < -0.01:
        return {"type": "roundhouse_kick"}

    if la_vel > STRIKE_VELOCITY_THRESHOLD and la_dy < -0.01:
        return {"type": "rear_kick"}

    return None


def _write_results_to_s3(s3_key: str, data: dict):
    """Write keypoint JSON to S3."""
    s3.put_object(
        Bucket=settings.S3_BUCKET_NAME,
        Key=s3_key,
        Body=json.dumps(data),
        ContentType="application/json",
    )