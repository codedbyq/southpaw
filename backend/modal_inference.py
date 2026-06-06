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
        "openai",
    ])
    .add_local_python_source("models")
    .add_local_python_source("db")
    .add_local_python_source("core")
    .add_local_python_source("services")
)

# Model per subscription tier
TIER_MODELS = {
    "free":  "yolov8n-pose.pt",
    "pro":   "yolov8s-pose.pt",
    "elite": "yolov8m-pose.pt",
}

# LLM model per subscription tier for clip-level coaching feedback
TIER_LLM_MODELS = {
    "free":  "deepseek-chat",
    "pro":   "deepseek-chat",
    "elite": "deepseek-reasoner",
}

STRIKE_VELOCITY_THRESHOLD = 0.08
STRIKE_COOLDOWN_FRAMES = 15
VELOCITY_WINDOW = 5
MIN_KEYPOINT_CONF = 0.3


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
    from models.user import User

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

            # Thumbnail extraction (non-fatal)
            try:
                thumb_key = _extract_and_upload_thumbnail(
                    tmp_path, clip_id, clip.clerk_user_id, s3
                )
                if thumb_key:
                    clip.thumbnail_s3_key = thumb_key
                    db.commit()
            except Exception as thumb_err:
                logger.warning(f"Thumbnail generation failed (non-fatal): {thumb_err}")

            # Head movement score + stance detection
            head_score = _compute_head_movement(frames_data)
            if head_score is not None:
                clip.head_movement_score = head_score
            clip.stance = _detect_stance(frames_data)
            db.commit()

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

            # Compute recovery_seconds (time from each strike to the next)
            for i, strike in enumerate(strikes_data):
                if i + 1 < len(strikes_data):
                    strike["recovery_seconds"] = round(
                        strikes_data[i + 1]["timestamp_seconds"] - strike["timestamp_seconds"], 3
                    )
                else:
                    strike["recovery_seconds"] = None

            # Write strikes to Postgres with full metrics
            strike_rows = []
            for strike in strikes_data:
                row = Strike(
                    job_id=job.id,
                    type=strike["type"],
                    timestamp_seconds=strike["timestamp_seconds"],
                    frame_index=strike["frame_index"],
                    confidence=None,
                    arm_extension=strike.get("arm_extension"),
                    guard_dropped=strike.get("guard_dropped"),
                    peak_velocity=strike.get("peak_velocity"),
                    recovery_seconds=strike.get("recovery_seconds"),
                    hip_rotation=strike.get("hip_rotation"),
                )
                db.add(row)
                strike_rows.append(row)
            db.commit()

            # Mark complete — user can view clip immediately
            job.status = "complete"
            job.progress = 100
            job.result_s3_key = result_s3_key
            db.commit()

            publish("complete", 100, result_url=result_s3_key)

            # Generate clip-level LLM coaching feedback (post-complete,
            # so the user sees the player page while this runs)
            try:
                from services.feedback import build_clip_summary, generate_feedback_sync

                user = db.execute(
                    select(User).where(User.clerk_user_id == clip.clerk_user_id)
                ).scalar_one_or_none()
                summary = build_clip_summary(clip, strike_rows, user=user)
                llm_model = TIER_LLM_MODELS.get(tier, "deepseek-chat")
                clip.feedback = generate_feedback_sync(summary, llm_model=llm_model)
                db.commit()
            except Exception as fb_err:
                logger.error(f"Clip feedback generation failed for clip {clip_id}: {fb_err}")
                db.rollback()

            # Mark parent session dirty so cached feedback regenerates
            if clip.session_id:
                from models.session import Session as SessionModel
                session_obj = db.execute(
                    select(SessionModel).where(SessionModel.id == clip.session_id)
                ).scalar_one_or_none()
                if session_obj:
                    session_obj.llm_summary_dirty = True
                    db.commit()

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


def _distance(kps, a, b) -> float:
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

    lw_vel, lw_dx, lw_dy = velocity(9)
    rw_vel, rw_dx, rw_dy = velocity(10)
    la_vel, la_dx, la_dy = velocity(15)
    ra_vel, ra_dx, ra_dy = velocity(16)

    left_hook_shape  = abs(current[9]["x"]  - current[7]["x"]) < 0.1
    right_hook_shape = abs(current[10]["x"] - current[8]["x"]) < 0.1

    strike_type = None
    striking_side = None
    peak_vel = 0.0

    if rw_vel > STRIKE_VELOCITY_THRESHOLD and abs(rw_dx) > abs(rw_dy):
        strike_type = "hook" if right_hook_shape else "jab"
        striking_side = "right"
        peak_vel = rw_vel
    elif lw_vel > STRIKE_VELOCITY_THRESHOLD and abs(lw_dx) > abs(lw_dy):
        strike_type = "hook" if left_hook_shape else "cross"
        striking_side = "left"
        peak_vel = lw_vel
    elif ra_vel > STRIKE_VELOCITY_THRESHOLD and ra_dy < -0.01:
        strike_type = "roundhouse_kick"
        striking_side = "kick"
        peak_vel = ra_vel
    elif la_vel > STRIKE_VELOCITY_THRESHOLD and la_dy < -0.01:
        strike_type = "rear_kick"
        striking_side = "kick"
        peak_vel = la_vel

    if strike_type is None:
        return None

    # arm_extension: shoulder-to-wrist distance at peak velocity
    arm_extension = None
    if striking_side == "right":
        if current[6]["visibility"] > MIN_KEYPOINT_CONF and current[10]["visibility"] > MIN_KEYPOINT_CONF:
            arm_extension = _distance(current, 6, 10)
    elif striking_side == "left":
        if current[5]["visibility"] > MIN_KEYPOINT_CONF and current[9]["visibility"] > MIN_KEYPOINT_CONF:
            arm_extension = _distance(current, 5, 9)

    # guard_dropped: non-striking hand below nose
    guard_dropped = None
    nose_y = current[0]["y"]
    if current[0]["visibility"] > MIN_KEYPOINT_CONF:
        if striking_side == "right" and current[9]["visibility"] > MIN_KEYPOINT_CONF:
            guard_dropped = bool(current[9]["y"] > nose_y)
        elif striking_side == "left" and current[10]["visibility"] > MIN_KEYPOINT_CONF:
            guard_dropped = bool(current[10]["y"] > nose_y)
        elif striking_side == "kick":
            if current[9]["visibility"] > MIN_KEYPOINT_CONF and current[10]["visibility"] > MIN_KEYPOINT_CONF:
                guard_dropped = bool(current[9]["y"] > nose_y or current[10]["y"] > nose_y)

    # hip_rotation: torso rotation from start to peak of strike
    hip_rotation = None
    hip_kps = [5, 6, 11, 12]
    if all(current[k]["visibility"] > MIN_KEYPOINT_CONF for k in hip_kps) and \
       all(past[k]["visibility"] > MIN_KEYPOINT_CONF for k in hip_kps):
        import math
        def _angle(kps, a, b):
            dx = kps[b]["x"] - kps[a]["x"]
            dy = kps[b]["y"] - kps[a]["y"]
            return math.degrees(math.atan2(dy, dx))
        shoulder_angle_start = _angle(past, 5, 6)
        shoulder_angle_end   = _angle(current, 5, 6)
        hip_angle_start      = _angle(past, 11, 12)
        hip_angle_end        = _angle(current, 11, 12)
        hip_rotation = round(abs((shoulder_angle_end - shoulder_angle_start) -
                                  (hip_angle_end - hip_angle_start)), 2)

    return {
        "type": strike_type,
        "arm_extension": arm_extension,
        "guard_dropped": guard_dropped,
        "peak_velocity": round(peak_vel, 4),
        "hip_rotation": hip_rotation,
    }


def _extract_and_upload_thumbnail(video_path, clip_id, clerk_user_id, s3_client):
    import cv2
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(fps))
    ret, frame = cap.read()
    cap.release()

    if not ret:
        cap = cv2.VideoCapture(video_path)
        ret, frame = cap.read()
        cap.release()

    if not ret or frame is None:
        return None

    rotation = _get_video_rotation(video_path)
    if rotation:
        frame = _apply_rotation(frame, rotation)

    _, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    key = f"clips/{clip_id}/thumbnail.jpg"
    s3_client.put_object(
        Bucket=os.environ["S3_BUCKET_NAME"],
        Key=key,
        Body=buf.tobytes(),
        ContentType="image/jpeg",
    )
    return key


def _compute_head_movement(frames_data) -> float | None:
    nose_xs = []
    nose_ys = []
    for frame in frames_data:
        for skeleton in frame.get("skeletons", []):
            kps = skeleton.get("keypoints", [])
            if kps and kps[0]["visibility"] > MIN_KEYPOINT_CONF:
                nose_xs.append(kps[0]["x"])
                nose_ys.append(kps[0]["y"])
                break
    if len(nose_xs) < 30:
        return None
    def _std(values):
        mean = sum(values) / len(values)
        return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5
    raw_score = (_std(nose_xs) + _std(nose_ys)) / 2
    return min(round(raw_score / 0.15, 3), 1.0)


def _detect_stance(frames_data) -> str | None:
    left_forward = 0
    right_forward = 0
    for frame in frames_data:
        for skeleton in frame.get("skeletons", []):
            kps = skeleton.get("keypoints", [])
            if len(kps) < 17:
                continue
            la, ra = kps[15], kps[16]
            if la["visibility"] > MIN_KEYPOINT_CONF and ra["visibility"] > MIN_KEYPOINT_CONF:
                if la["x"] < ra["x"]:
                    left_forward += 1
                else:
                    right_forward += 1
            break
    total = left_forward + right_forward
    if total < 30:
        return "unknown"
    left_ratio = left_forward / total
    if left_ratio > 0.6:
        return "orthodox"
    elif left_ratio < 0.4:
        return "southpaw"
    return "unknown"


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