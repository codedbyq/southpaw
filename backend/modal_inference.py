import modal
import json
import os
import tempfile
import subprocess
import logging

logger = logging.getLogger(__name__)

# --- Modal app definition ---

app = modal.App("southpaw-inference")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install([
        "ffmpeg",
        "libgl1",
        "libglib2.0-0",
    ])
    .pip_install([
        "ultralytics",
        "opencv-python-headless",
        "boto3",
        "sqlalchemy",
        "psycopg2-binary",
        "redis",
        "pydantic-settings",
    ])
    .add_local_python_source("models")
    .add_local_python_source("db")
    .add_local_python_source("core")
)

# Model per subscription tier
TIER_MODELS = {
    "free":  "yolov8n-pose.pt",
    "pro":   "yolov8s-pose.pt",
    "elite": "yolov8m-pose.pt",
}

STRIKE_VELOCITY_THRESHOLD = 0.08
STRIKE_COOLDOWN_FRAMES = 15
VELOCITY_WINDOW = 5


# --- Main inference function ---

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("southpaw-secrets")],
    memory=4096,
    timeout=600,
    retries=2,
)
def run_inference(clip_id: str, job_id: str, s3_key: str, tier: str = "free"):
    """
    Runs YOLOv8 pose estimation on a clip.
    Called via run_inference.spawn() from FastAPI — fire and forget.
    Publishes SSE progress events to Upstash Redis pub/sub.
    """
    import boto3
    import redis as redis_lib
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker
    from ultralytics import YOLO
    import cv2

    # --- Clients ---
    s3 = boto3.client(
        "s3",
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        region_name=os.environ["AWS_REGION"],
    )

    redis_client = redis_lib.from_url(
        os.environ["REDIS_URL"],
        ssl_cert_reqs=None,
    )

    engine = create_engine(
        os.environ["DATABASE_URL"],
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )
    Session = sessionmaker(bind=engine)

    # Import models — they live in the backend package
    # Modal mounts the local directory so imports work
    from models.job import Job
    from models.clip import Clip
    from models.strike import Strike

    model_name = TIER_MODELS.get(tier, "yolov8n-pose.pt")
    model = YOLO(model_name)

    def publish(status: str, progress: int, result_url: str = None):
        payload = {"status": status, "progress": progress}
        if result_url:
            payload["result_url"] = result_url
        redis_client.publish(f"job:{job_id}", json.dumps(payload))

    tmp_path = None

    with Session() as db:
        job = db.execute(select(Job).where(Job.id == job_id)).scalar_one()
        clip = db.execute(select(Clip).where(Clip.id == clip_id)).scalar_one()

        try:
            # Mark processing
            job.status = "processing"
            job.progress = 0
            db.commit()
            publish("processing", 0)

            # Download clip from S3
            suffix = os.path.splitext(s3_key)[-1] or ".mp4"
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            s3.download_fileobj(os.environ["S3_BUCKET_NAME"], s3_key, tmp)
            tmp.close()
            tmp_path = tmp.name

            # Detect EXIF rotation
            rotation = _get_video_rotation(tmp_path)

            # Process video
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

                if rotation:
                    frame = _apply_rotation(frame, rotation)

                results = model(frame, verbose=False)

                timestamp = frame_index / fps
                frame_strikes = []
                skeletons = []

                for subject_idx, result in enumerate(results):
                    if result.keypoints is None:
                        continue

                    kps = result.keypoints.xy[0].cpu().numpy()
                    conf = result.keypoints.conf[0].cpu().numpy()
                    h, w = frame.shape[:2]

                    keypoints = [
                        {
                            "x": float(kps[i][0] / w),
                            "y": float(kps[i][1] / h),
                            "visibility": float(conf[i]),
                        }
                        for i in range(len(kps))
                    ]
                    skeletons.append({"id": subject_idx, "keypoints": keypoints})

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
                    publish("processing", progress)

                frame_index += 1

            cap.release()

            # Write keypoint JSON to S3
            result_s3_key = f"processed/{clip.clerk_user_id}/{clip_id}/keypoints.json"
            s3.put_object(
                Bucket=os.environ["S3_BUCKET_NAME"],
                Key=result_s3_key,
                Body=json.dumps({
                    "clip_id": clip_id,
                    "total_frames": frame_index,
                    "frames": frames_data,
                }),
                ContentType="application/json",
            )

            # Write strikes to Postgres
            for strike in strikes_data:
                db.add(Strike(
                    job_id=job.id,
                    type=strike["type"],
                    timestamp_seconds=strike["timestamp_seconds"],
                    frame_index=strike["frame_index"],
                    confidence=None,
                ))
            db.commit()

            # Mark complete
            job.status = "complete"
            job.progress = 100
            job.result_s3_key = result_s3_key
            db.commit()

            publish("complete", 100, result_url=result_s3_key)

        except Exception as e:
            logger.error(f"Inference failed for job {job_id}: {e}")
            job.status = "failed"
            job.error = str(e)
            db.commit()
            publish("failed", 0)
            raise

        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)


# --- Helper functions ---

def _get_video_rotation(filepath: str) -> int:
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
    except Exception:
        pass
    return 0


def _apply_rotation(frame, rotation: int):
    import cv2
    if rotation == 90:
        return cv2.rotate(frame, cv2.ROTATE_90_CLOCKWISE)
    elif rotation == 180:
        return cv2.rotate(frame, cv2.ROTATE_180)
    elif rotation == 270:
        return cv2.rotate(frame, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return frame


def _classify_strike(history, current_frame, last_strike_frame):
    if current_frame - last_strike_frame < STRIKE_COOLDOWN_FRAMES:
        return None

    current = history[-1]
    past = history[0]

    def velocity(idx):
        dx = current[idx]["x"] - past[idx]["x"]
        dy = current[idx]["y"] - past[idx]["y"]
        return (dx**2 + dy**2) ** 0.5, dx, dy

    lw_vel, lw_dx, lw_dy = velocity(9)
    rw_vel, rw_dx, rw_dy = velocity(10)
    la_vel, la_dx, la_dy = velocity(15)
    ra_vel, ra_dx, ra_dy = velocity(16)

    left_elbow_x  = current[7]["x"]
    left_wrist_x  = current[9]["x"]
    right_elbow_x = current[8]["x"]
    right_wrist_x = current[10]["x"]

    left_hook_shape  = abs(left_wrist_x - left_elbow_x) < 0.1
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


# --- Coach thumbnail extraction ---

thumb_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install(["ffmpeg", "libgl1", "libglib2.0-0"])
    .pip_install(["opencv-python-headless", "boto3", "sqlalchemy", "psycopg2-binary"])
)


@app.function(
    image=thumb_image,
    secrets=[modal.Secret.from_name("southpaw-secrets")],
    memory=512,
    timeout=60,
    retries=2,
)
def extract_coach_thumbnail(profile_id: str, intro_video_s3_key: str):
    """
    Extract a thumbnail frame from a coach intro video and store it in S3.
    Lightweight task — no YOLO, just frame extraction.
    """
    import boto3
    import cv2

    s3 = boto3.client(
        "s3",
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        region_name=os.environ["AWS_REGION"],
    )
    bucket = os.environ["S3_BUCKET_NAME"]

    # Download video
    suffix = os.path.splitext(intro_video_s3_key)[-1] or ".mp4"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    s3.download_fileobj(bucket, intro_video_s3_key, tmp)
    tmp.close()
    tmp_path = tmp.name

    try:
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
                Bucket=bucket,
                Key=thumb_key,
                Body=buf.tobytes(),
                ContentType="image/jpeg",
            )

            # Update the coach profile row
            from sqlalchemy import create_engine, text
            from sqlalchemy.orm import sessionmaker

            engine = create_engine(
                os.environ["DATABASE_URL"],
                pool_pre_ping=True,
                connect_args={"sslmode": "require"},
            )
            Session = sessionmaker(bind=engine)
            with Session() as db:
                db.execute(
                    text("UPDATE coach_profiles SET intro_video_thumb_s3_key = :key WHERE id = CAST(:id AS uuid)"),
                    {"key": thumb_key, "id": profile_id},
                )
                db.commit()

            logger.info(f"Stored intro video thumbnail for coach profile {profile_id}")
        else:
            logger.warning(f"Could not extract frame from intro video for profile {profile_id}")

    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)