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
from models.session import Session
from models.strike import Strike
from core.config import settings
from services.feedback import build_clip_summary, generate_feedback_sync
import redis as redis_lib
import subprocess


logger = logging.getLogger(__name__)

# Load YOLOv8 pose model once at module level
# Downloads automatically on first run (~6MB)
model = YOLO("yolov8s-pose.pt")  # s = small, better keypoint accuracy than nano

# S3 client for the worker
s3 = boto3.client(
    "s3",
    aws_access_key_id=settings.AWS_ACCESS_KEY_ID,
    aws_secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
    region_name=settings.AWS_REGION,
)

# Redis pub/sub client for real-time updates on upload progress
redis_client = redis_lib.from_url(settings.REDIS_URL)

# How many consecutive frames we look back to calculate velocity
VELOCITY_WINDOW = 5

# Minimum wrist/ankle velocity (normalized 0-1 units per frame) to count as a strike
STRIKE_VELOCITY_THRESHOLD = 0.08

# Minimum frames between detected strikes to avoid double-counting
STRIKE_COOLDOWN_FRAMES = 15

# Minimum keypoint confidence to trust a measurement for metrics
MIN_KEYPOINT_CONF = 0.3


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

            # Step 2 — extract and store thumbnail (non-fatal)
            try:
                thumb_key = _extract_and_upload_thumbnail(tmp_path, clip_id, clip.clerk_user_id)
                if thumb_key:
                    clip.thumbnail_s3_key = thumb_key
                    db.commit()
                    logger.info(f"Uploaded thumbnail for clip {clip_id}")
            except Exception as thumb_exc:
                logger.warning(f"Thumbnail generation failed (non-fatal): {thumb_exc}")

            # Step 3 — run YOLOv8 frame by frame
            frames_data, strikes_data, total_frames = _process_video(
                tmp_path, job_id, job, db
            )

            # Step 4 — compute head movement score from nose keypoint variance
            head_score = _compute_head_movement(frames_data)
            if head_score is not None:
                clip.head_movement_score = head_score
                db.commit()
                logger.info(f"Head movement score for clip {clip_id}: {head_score}")

            # Step 5 — write keypoint JSON to S3
            result_s3_key = f"processed/{clip.clerk_user_id}/{clip_id}/keypoints.json"
            _write_results_to_s3(result_s3_key, {
                "clip_id": clip_id,
                "total_frames": total_frames,
                "frames": frames_data,
            })
            logger.info(f"Wrote keypoint JSON to S3: {result_s3_key}")

            # Step 6 — write strike rows to Postgres
            for strike in strikes_data:
                db.add(Strike(
                    job_id=job.id,
                    type=strike["type"],
                    timestamp_seconds=strike["timestamp_seconds"],
                    frame_index=strike["frame_index"],
                    confidence=None,  # rules-based has no confidence score
                    arm_extension=strike.get("arm_extension"),
                    guard_dropped=strike.get("guard_dropped"),
                ))
            db.commit()
            logger.info(f"Wrote {len(strikes_data)} strikes to Postgres")

            # Generate and store clip-level feedback (non-fatal if LLM call fails)
            try:
                strikes_for_feedback = db.execute(select(Strike).where(Strike.job_id == job.id)).scalars().all()
                if strikes_for_feedback:
                    summary = build_clip_summary(clip, strikes_for_feedback)
                    clip.feedback = generate_feedback_sync(summary)
                    db.commit()
                    logger.info(f"Generated clip feedback for clip {clip_id}")
            except Exception as feedback_exc:
                logger.warning(f"Clip feedback generation failed (non-fatal): {feedback_exc}")

            # Mark parent session dirty — new strike data means cached feedback is stale
            if clip.session_id:
                session = db.execute(select(Session).where(Session.id == clip.session_id)).scalar_one_or_none()
                if session:
                    session.llm_summary_dirty = True
                    db.commit()

            # Step 7 — mark job complete
            job.status = "complete"
            job.progress = 100
            job.result_s3_key = result_s3_key
            db.commit()
            _publish_progress(job_id, "complete", 100, result_url=result_s3_key)

            # Notify athlete clip is ready
            _notify_clip_complete_sync(db, clip)

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


@celery_app.task(bind=True, max_retries=2)
def extract_coach_thumbnail(self, profile_id: str, intro_video_s3_key: str):
    """
    Lightweight task — extract a thumbnail from a coach intro video and store it.
    No YOLO processing, just frame extraction.
    """
    logger.info(f"Extracting intro video thumbnail for coach profile {profile_id}")

    try:
        tmp_path = _download_clip(intro_video_s3_key)
        thumb_key = f"coach-profiles/{profile_id}/intro_thumb.jpg"

        cap = cv2.VideoCapture(tmp_path)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps))  # 1 second in
        ret, frame = cap.read()
        cap.release()

        if not ret:
            cap = cv2.VideoCapture(tmp_path)
            ret, frame = cap.read()
            cap.release()

        if ret and frame is not None:
            rotation = _get_video_rotation(tmp_path)
            if rotation:
                frame = _apply_rotation(frame, rotation)
            _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            s3.put_object(
                Bucket=settings.S3_BUCKET_NAME,
                Key=thumb_key,
                Body=buf.tobytes(),
                ContentType="image/jpeg",
            )

            with get_sync_session() as db:
                from sqlalchemy import text
                result = db.execute(
                    text("UPDATE coach_profiles SET intro_video_thumb_s3_key = :key WHERE id = CAST(:id AS uuid)"),
                    {"key": thumb_key, "id": profile_id}
                )
                db.commit()
                if result.rowcount > 0:
                    logger.info(f"Stored intro video thumbnail for profile {profile_id}")
                else:
                    logger.warning(f"No coach profile row found for id {profile_id}")

    except Exception as exc:
        logger.error(f"Coach thumbnail extraction failed: {exc}")
        raise self.retry(exc=exc, countdown=10)
    finally:
        if 'tmp_path' in locals() and os.path.exists(tmp_path):
            os.remove(tmp_path)


def _extract_and_upload_thumbnail(video_path: str, clip_id: str, user_id: str) -> str | None:
    """Extract a frame ~1s in, upload as JPEG to S3. Returns the S3 key or None."""
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    target_frame = int(fps)  # 1 second in
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ret, frame = cap.read()
    cap.release()

    if not ret:
        # Fall back to frame 0 if seek failed
        cap = cv2.VideoCapture(video_path)
        ret, frame = cap.read()
        cap.release()

    if not ret or frame is None:
        return None

    # Apply rotation so thumbnail matches browser rendering
    rotation = _get_video_rotation(video_path)
    if rotation:
        frame = _apply_rotation(frame, rotation)

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    key = f"clips/{clip_id}/thumbnail.jpg"
    s3.put_object(
        Bucket=settings.S3_BUCKET_NAME,
        Key=key,
        Body=buf.tobytes(),
        ContentType="image/jpeg",
    )
    return key


def _download_clip(s3_key: str) -> str:
    """Download clip from S3 to a temp file. Returns the local file path."""
    suffix = os.path.splitext(s3_key)[-1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    s3.download_fileobj(settings.S3_BUCKET_NAME, s3_key, tmp)
    tmp.close()
    return tmp.name

def _get_video_rotation(filepath: str) -> int:
    """Read EXIF rotation from video metadata using ffprobe."""
    try:
        result = subprocess.run([
            'ffprobe', '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams',
            filepath
        ], capture_output=True, text=True)
        data = json.loads(result.stdout)
        for stream in data.get('streams', []):
            tags = stream.get('tags', {})
            rotation = tags.get('rotate') or tags.get('rotation')
            if rotation:
                return int(rotation)
    except Exception as e:
        logger.warning(f"Could not read video rotation: {e}")
    return 0


def _apply_rotation(frame, rotation: int):
    """Rotate frame to match EXIF orientation so keypoints align with browser rendering."""
    if rotation == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    elif rotation == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame

def _process_video(tmp_path: str, job_id: str, job, db) -> tuple:
    cap = cv2.VideoCapture(tmp_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30

    # Detect EXIF rotation once before processing
    rotation = _get_video_rotation(tmp_path)
    if rotation:
        logger.info(f"Detected video rotation: {rotation}°")

    frames_data = []
    strikes_data = []
    keypoint_history = {}
    last_strike_frame = {}
    frame_index = 0

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        if rotation:
            frame = _apply_rotation(frame, rotation)

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
            _publish_progress(job_id, "processing", progress)
            logger.info(f"Job {job_id} progress: {progress}%")

        frame_index += 1

    cap.release()
    return frames_data, strikes_data, frame_index


# COCO 17 keypoint indices used here:
# 0  = nose
# 5  = left shoulder   6  = right shoulder
# 7  = left elbow      8  = right elbow
# 9  = left wrist      10 = right wrist
# 15 = left ankle      16 = right ankle

def _distance(kps, a, b) -> float:
    """Euclidean distance between two keypoints (normalized 0-1 coords)."""
    dx = kps[a]["x"] - kps[b]["x"]
    dy = kps[a]["y"] - kps[b]["y"]
    return round((dx**2 + dy**2) ** 0.5, 4)


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

    left_hook_shape  = abs(current[9]["x"]  - current[7]["x"]) < 0.1
    right_hook_shape = abs(current[10]["x"] - current[8]["x"]) < 0.1

    # Determine strike type and which side threw it
    strike_type = None
    striking_side = None  # "right" | "left" | "kick"

    if rw_vel > STRIKE_VELOCITY_THRESHOLD and abs(rw_dx) > abs(rw_dy):
        strike_type = "hook" if right_hook_shape else "jab"
        striking_side = "right"
    elif lw_vel > STRIKE_VELOCITY_THRESHOLD and abs(lw_dx) > abs(lw_dy):
        strike_type = "hook" if left_hook_shape else "cross"
        striking_side = "left"
    elif ra_vel > STRIKE_VELOCITY_THRESHOLD and ra_dy < -0.01:
        strike_type = "roundhouse_kick"
        striking_side = "kick"
    elif la_vel > STRIKE_VELOCITY_THRESHOLD and la_dy < -0.01:
        strike_type = "rear_kick"
        striking_side = "kick"

    if strike_type is None:
        return None

    # --- arm_extension: shoulder-to-wrist distance at peak velocity ---
    # Larger value = more extended arm. Kicks have no arm_extension.
    arm_extension = None
    if striking_side == "right":
        if current[6]["visibility"] > MIN_KEYPOINT_CONF and current[10]["visibility"] > MIN_KEYPOINT_CONF:
            arm_extension = _distance(current, 6, 10)  # right shoulder → right wrist
    elif striking_side == "left":
        if current[5]["visibility"] > MIN_KEYPOINT_CONF and current[9]["visibility"] > MIN_KEYPOINT_CONF:
            arm_extension = _distance(current, 5, 9)   # left shoulder → left wrist

    # --- guard_dropped: was the opposite hand below the nose during the strike? ---
    # In image coords y increases downward, so wrist_y > nose_y means hand is below nose.
    guard_dropped = None
    nose_y = current[0]["y"]
    if current[0]["visibility"] > MIN_KEYPOINT_CONF:
        if striking_side == "right" and current[9]["visibility"] > MIN_KEYPOINT_CONF:
            guard_dropped = bool(current[9]["y"] > nose_y)   # left (guard) wrist below nose?
        elif striking_side == "left" and current[10]["visibility"] > MIN_KEYPOINT_CONF:
            guard_dropped = bool(current[10]["y"] > nose_y)  # right (guard) wrist below nose?
        elif striking_side == "kick":
            lw_conf = current[9]["visibility"]
            rw_conf = current[10]["visibility"]
            if lw_conf > MIN_KEYPOINT_CONF and rw_conf > MIN_KEYPOINT_CONF:
                guard_dropped = bool(current[9]["y"] > nose_y or current[10]["y"] > nose_y)

    return {
        "type": strike_type,
        "arm_extension": arm_extension,
        "guard_dropped": guard_dropped,
    }


def _write_results_to_s3(s3_key: str, data: dict):
    """Write keypoint JSON to S3."""
    s3.put_object(
        Bucket=settings.S3_BUCKET_NAME,
        Key=s3_key,
        Body=json.dumps(data),
        ContentType="application/json",
    )

def _compute_head_movement(frames_data: list) -> float | None:
    """
    Compute head movement score from nose keypoint (index 0) variance across frames.
    Returns a 0-1 score — higher means more active head movement.
    Returns None if insufficient confident nose readings.
    """
    nose_xs = []
    nose_ys = []

    for frame in frames_data:
        for skeleton in frame.get("skeletons", []):
            kps = skeleton.get("keypoints", [])
            if kps and kps[0]["visibility"] > MIN_KEYPOINT_CONF:
                nose_xs.append(kps[0]["x"])
                nose_ys.append(kps[0]["y"])
                break  # only track primary subject (first skeleton)

    if len(nose_xs) < 30:  # need at least 1 second of data at 30fps
        return None

    def _std(values):
        mean = sum(values) / len(values)
        variance = sum((v - mean) ** 2 for v in values) / len(values)
        return variance ** 0.5

    # Average std across x and y axes, capped at 0.15 (very large movement) then normalized 0-1
    raw_score = (_std(nose_xs) + _std(nose_ys)) / 2
    normalized = min(round(raw_score / 0.15, 3), 1.0)
    return normalized


def _notify_clip_complete_sync(db, clip):
    """Create a clip_processing_complete notification for the clip owner (sync, Celery)."""
    try:
        from sqlalchemy import select as sa_select
        from models.user import User
        from services.notifications import create_notification_sync

        user = db.execute(
            sa_select(User).where(User.clerk_user_id == clip.clerk_user_id)
        ).scalar_one_or_none()

        if user:
            create_notification_sync(
                db,
                user_id=user.id,
                type="clip_processing_complete",
                title="Clip ready",
                body=f'"{clip.filename}" has been analysed and is ready to view.',
                reference_id=clip.id,
                reference_type="clip",
            )
            db.commit()
            logger.info(f"Created clip_processing_complete notification for user {user.id}")
        else:
            logger.warning(f"No user row found for clerk_user_id={clip.clerk_user_id} — skipping notification")
    except Exception as e:
        import traceback
        logger.warning(f"Failed to create clip notification (non-fatal): {e}\n{traceback.format_exc()}")


def _publish_progress(job_id: str, status: str, progress: int, result_url: str = None):
    """Publish a progress event to the Redis pub/sub channel for this job."""
    import json
    payload = {"status": status, "progress": progress}
    if result_url:
        payload["result_url"] = result_url
    redis_client.publish(f"job:{job_id}", json.dumps(payload))