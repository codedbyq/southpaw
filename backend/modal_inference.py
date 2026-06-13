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
        "supervision<0.30",     # ByteTrack multi-person tracking (sv.ByteTrack removed in 0.30)
        "torchreid",            # OSNet-AIN person ReID for the athlete gallery
        "tensorboard",          # torchreid import dependency
    ])
    .add_local_python_source("models")
    .add_local_python_source("db")
    .add_local_python_source("core")
    .add_local_python_source("services")
)

# Model per subscription tier (YOLO11 — fewer params, better pose accuracy than v8)
# BETA: small is the floor for everyone — nano's keypoint jitter undermines the
# velocity-based classifier, and data quality is the product thesis. Restore
# free→nano at public launch when GPU cost matters at scale.
TIER_MODELS = {
    "free":  "yolo11s-pose.pt",
    "pro":   "yolo11s-pose.pt",
    "elite": "yolo11m-pose.pt",
}

# LLM model per subscription tier for clip-level coaching feedback
TIER_LLM_MODELS = {
    "free":  "deepseek-chat",
    "pro":   "deepseek-chat",
    "elite": "deepseek-reasoner",
}

# Strike classification lives in services/strike_classifier.py (pure Python,
# time-based + torso-normalized) and runs as a post-pass over the tracked
# keypoints — the same code path the golden-set harness replays offline.

TARGET_SHORT_SIDE = 720   # downscale before inference; pose accuracy holds
MAX_EFFECTIVE_FPS = 45    # above this (60fps phones), process every 2nd frame

STALE_HEARTBEAT_MINUTES = 10   # reaper: processing job with no heartbeat
STALE_QUEUED_MINUTES = 15      # reaper: spawned but never started

# Gallery overrides the primary-subject heuristic only when its margin-based
# confidence clears this (validation: correct picks scored 0.3-1.0; tight
# cross-modality cases ~0.3 keep the heuristic + chips for manual correction).
GALLERY_OVERRIDE_MIN_CONF = 0.4


class PipelineError(Exception):
    """Failure with a machine-readable code + user-readable message."""
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


# --- Main inference function ---

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("southpaw-secrets")],
    gpu="T4",          # NVIDIA T4 — cheapest GPU; ~8-10x faster than CPU for pose
    memory=4096,
    timeout=1800,      # 30 min safety net (cold start + long clip); bills actual runtime
    retries=2,
)
def run_inference(clip_id: str, job_id: str, s3_key: str, tier: str = "free"):
    """
    Runs YOLO11 pose estimation on a clip with ByteTrack multi-person tracking.
    Called via run_inference.spawn() from FastAPI — fire and forget.
    Publishes SSE progress events to Upstash Redis pub/sub.
    """
    import time
    from datetime import datetime, timezone

    import boto3
    import redis as redis_lib
    from sqlalchemy import create_engine, select, delete
    from sqlalchemy.orm import sessionmaker
    from ultralytics import YOLO
    import cv2
    import numpy as np
    import supervision as sv

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

    # This function uses a SYNC engine (psycopg2) — tolerate an async URL in
    # the secret by stripping the +asyncpg driver suffix.
    engine = create_engine(
        os.environ["DATABASE_URL"].replace("+asyncpg", ""),
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

    model_name = TIER_MODELS.get(tier, "yolo11s-pose.pt")
    model = YOLO(model_name)

    # Confirm GPU is actually in use (vs a CPU-only torch build)
    import torch
    logger.info(f"Inference device: {'cuda' if torch.cuda.is_available() else 'cpu'} · model={model_name} · tier={tier}")

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
            stage_timings = {}
            stage_start = time.monotonic()

            # Mark processing. Modal retries this function (retries=2), so the
            # run must be idempotent: wipe any strikes a previous partial
            # attempt committed before doing anything else.
            from models.strike import Strike as StrikeModel
            db.execute(delete(StrikeModel).where(StrikeModel.job_id == job.id))
            job.status = "processing"
            job.progress = 0
            job.error = None
            job.error_code = None
            job.attempt = (job.attempt or 0) + 1
            job.started_at = datetime.now(timezone.utc)
            job.heartbeat_at = datetime.now(timezone.utc)
            db.commit()
            publish("processing", 0)

            # Download clip from S3
            suffix = os.path.splitext(s3_key)[-1] or ".mp4"
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            try:
                s3.download_fileobj(os.environ["S3_BUCKET_NAME"], s3_key, tmp)
            except Exception as e:
                raise PipelineError("s3_error", "Could not fetch the uploaded video") from e
            tmp.close()
            tmp_path = tmp.name
            stage_timings["download"] = round(time.monotonic() - stage_start, 2)
            stage_start = time.monotonic()

            # Detect EXIF rotation
            rotation = _get_video_rotation(tmp_path)

            # Process video
            cap = cv2.VideoCapture(tmp_path)
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
            fps = cap.get(cv2.CAP_PROP_FPS) or 30
            if not cap.isOpened() or total_frames <= 0:
                raise PipelineError("decode_error", "Video could not be read — try re-exporting it")

            # 60fps phone video → process every 2nd frame. The classifier is
            # time-based, so results match 30fps; this halves GPU time.
            stride = 2 if fps > MAX_EFFECTIVE_FPS else 1
            effective_fps = fps / stride

            # ByteTrack — persistent subject IDs across frames (Kalman + Hungarian).
            # lost_track_buffer keeps a briefly-occluded fighter for ~1s.
            tracker = sv.ByteTrack(
                track_activation_threshold=0.25,
                lost_track_buffer=int(round(effective_fps)),
                minimum_matching_threshold=0.8,
                frame_rate=int(round(effective_fps)),
            )

            APPEARANCE_SAMPLE_EVERY_S = 0.7
            APPEARANCE_MAX_CROPS = 2400
            appearance_crops, last_crop_t = [], {}
            frames_data = []
            luma_samples = []
            frame_index = 0
            processed = 0

            while cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    break
                if stride > 1 and frame_index % stride:
                    frame_index += 1
                    continue

                if rotation:
                    frame = _apply_rotation(frame, rotation)

                # Downscale to ~720p short side before inference — pose accuracy
                # holds and 4K phone video gets a 2-4x speedup.
                h, w = frame.shape[:2]
                if min(h, w) > TARGET_SHORT_SIDE:
                    scale = TARGET_SHORT_SIDE / min(h, w)
                    frame = cv2.resize(frame, (int(w * scale), int(h * scale)))
                    h, w = frame.shape[:2]

                if processed % 30 == 0:
                    luma_samples.append(float(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY).mean()))

                results = model(frame, verbose=False)
                result = results[0]

                timestamp = frame_index / fps
                skeletons = []

                if result.keypoints is not None and len(result.keypoints) > 0:
                    # Normalize YOLO output → Supervision Detections, then track.
                    detections = sv.Detections.from_ultralytics(result)
                    # Tag each detection with its row index into result.keypoints so we
                    # can map a tracked detection back to the right keypoints even if
                    # ByteTrack reorders or drops detections.
                    detections.data["kp_index"] = np.arange(len(detections))
                    detections = tracker.update_with_detections(detections)

                    for det_idx in range(len(detections)):
                        # Persistent subject identity across frames
                        tracker_id = (
                            int(detections.tracker_id[det_idx])
                            if detections.tracker_id is not None else det_idx
                        )
                        kp_index = int(detections.data["kp_index"][det_idx])

                        kps = result.keypoints.xy[kp_index].cpu().numpy()
                        conf = result.keypoints.conf[kp_index].cpu().numpy()

                        keypoints = [
                            {
                                "x": float(kps[i][0] / w),
                                "y": float(kps[i][1] / h),
                                "visibility": float(conf[i]),
                            }
                            for i in range(len(kps))
                        ]
                        skeletons.append({"id": tracker_id, "keypoints": keypoints})

                        # Appearance crop sampling for track repair — frames are
                        # already decoded here, so identity costs no second pass.
                        # Crops/embeddings are transient (D2/D3): discarded after
                        # repair, never persisted.
                        if timestamp - last_crop_t.get(tracker_id, -9.0) >= APPEARANCE_SAMPLE_EVERY_S \
                                and len(appearance_crops) < APPEARANCE_MAX_CROPS:
                            vis = kps[conf > 0.3]
                            if len(vis) >= 8:
                                x0, y0 = vis.min(axis=0)
                                x1, y1 = vis.max(axis=0)
                                mx, my = 0.07 * (x1 - x0), 0.07 * (y1 - y0)
                                a, b = max(0, int(x0 - mx)), min(w, int(x1 + mx))
                                c, d = max(0, int(y0 - my)), min(h, int(y1 + my))
                                if b - a >= 24 and d - c >= 48:
                                    crop = cv2.cvtColor(frame[c:d, a:b], cv2.COLOR_BGR2RGB)
                                    appearance_crops.append(
                                        (tracker_id, timestamp, cv2.resize(crop, (128, 256)))
                                    )
                                    last_crop_t[tracker_id] = timestamp

                frames_data.append({
                    "frame": frame_index,
                    "timestamp": round(timestamp, 4),
                    "skeletons": skeletons,
                    "strikes": [],   # filled by the classification post-pass
                })

                if processed % 30 == 0 and total_frames > 0:
                    progress = min(int((frame_index / total_frames) * 90), 90)
                    job.progress = progress
                    job.heartbeat_at = datetime.now(timezone.utc)
                    db.commit()
                    publish("processing", progress)

                frame_index += 1
                processed += 1

            cap.release()
            stage_timings["inference"] = round(time.monotonic() - stage_start, 2)
            stage_start = time.monotonic()

            if not any(f["skeletons"] for f in frames_data):
                raise PipelineError("no_person", "No people were detected in this video — check framing and lighting")

            # Track repair: embed the sampled crops (GPU), split identity
            # drifts, stitch fragmented tracklets with appearance
            # adjudication — BEFORE anything downstream reads subject ids.
            # Crops and embeddings are discarded after this block (D2/D3);
            # only the id-mapping report persists.
            from services.appearance import Embedder, AppearanceIndex
            from services.track_repair import apply_repair, REPAIR_VERSION

            repair_report = {"version": REPAIR_VERSION, "merges": [], "splits": {}}
            try:
                index = AppearanceIndex()
                embedder = Embedder()
                for i in range(0, len(appearance_crops), 64):
                    batch = appearance_crops[i:i + 64]
                    for (tid, t, _), emb in zip(batch, embedder.embed_batch([c for _, _, c in batch])):
                        index.add(tid, t, emb)
                repair_report = apply_repair(frames_data, appearance=index, strict=True)
            except Exception as repair_err:
                logger.warning(f"Track repair failed (non-fatal, raw tracks kept): {repair_err}")
            finally:
                appearance_crops = None
            stage_timings["track_repair"] = round(time.monotonic() - stage_start, 2)
            stage_start = time.monotonic()

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

            from services.clip_metrics import (
                compute_head_movement, detect_stance, apply_recovery_seconds,
                subject_summaries, score_subjects, skeletal_stats, compute_pose_quality,
            )
            from services.strike_classifier import (
                classify_clip, RULES_VERSION, MIN_PERSISTED_CONFIDENCE,
            )

            pipeline_version = f"v3:{model_name}:{RULES_VERSION}+{REPAIR_VERSION}"

            # Classification post-pass: per-subject stance first (jab/cross
            # naming is stance-dependent), then time-based, torso-normalized
            # strike rules over the tracked keypoints.
            subject_ids = {sk["id"] for f in frames_data for sk in f["skeletons"]}
            stances = {sid: detect_stance(frames_data, sid) for sid in subject_ids}
            strikes_data = classify_clip(
                frames_data, stances, clip_type=getattr(clip, "clip_type", None)
            )

            # Primary subject: composite of presence, size, center bias, and
            # strike activity — not just whoever is closest to the camera.
            # The user can still override in the player.
            strike_counts = {}
            for strike in strikes_data:
                if not strike.get("low_confidence"):
                    strike_counts[strike["subject_id"]] = strike_counts.get(strike["subject_id"], 0) + 1
            primary_subject, subject_confidence, _ = score_subjects(frames_data, strike_counts)

            # Athlete gallery (ReID): for a returning consented athlete with a
            # gallery, rank the meaningful subjects against it and override the
            # heuristic pick when the gallery is confident. Only the athlete's
            # embedding is ever persisted (D2); opponents' are transient here.
            # Must run BEFORE strike persistence so the right subject's strikes
            # are written.
            athlete_embeddings = {}
            user_row = None
            try:
                user_row = db.execute(
                    select(User).where(User.clerk_user_id == clip.clerk_user_id)
                ).scalar_one_or_none()
                if user_row is not None and getattr(user_row, "biometric_consent_at", None):
                    from models.identity_sample import IdentitySample
                    from services.gallery import build_gallery, rank_subjects, _stats_to_vec
                    from services.reid_embedder import embed_subjects

                    meaningful_ids = [
                        s["id"] for s in subject_summaries(frames_data)
                        if s["frames"] >= 0.3 * max(len(frames_data), 1)
                    ]
                    gallery_samples = db.execute(
                        select(IdentitySample).where(
                            IdentitySample.user_id == user_row.id,
                            IdentitySample.revoked_at.is_(None),
                            IdentitySample.embedding.isnot(None),
                        )
                    ).scalars().all()
                    gallery = build_gallery(gallery_samples)

                    if gallery is not None and len(meaningful_ids) > 1:
                        athlete_embeddings = embed_subjects(tmp_path, frames_data, meaningful_ids, s3_client=s3)
                        subjects = {
                            sid: {"embedding": emb,
                                  "skeletal": _stats_to_vec(skeletal_stats(frames_data, sid))}
                            for sid, emb in athlete_embeddings.items()
                        }
                        ranked, gconf = rank_subjects(gallery, subjects)
                        if ranked and gconf >= GALLERY_OVERRIDE_MIN_CONF:
                            primary_subject = ranked[0][0]
                            subject_confidence = gconf
                            logger.info(f"Gallery override: subject {primary_subject} (conf {gconf})")
            except Exception as gal_err:
                logger.warning(f"Gallery matching failed (non-fatal, heuristic kept): {gal_err}")

            # recovery_seconds = gap to *this subject's* next strike (not the
            # opponent's). Compute per-subject in place — JSON shares these dicts.
            by_subject = {}
            for strike in strikes_data:
                by_subject.setdefault(strike.get("subject_id"), []).append(strike)
            for group in by_subject.values():
                group.sort(key=lambda s: s["timestamp_seconds"])
                apply_recovery_seconds(group)

            # Footage quality — drives the UI banner and LLM confidence gating
            mean_luma = sum(luma_samples) / len(luma_samples) if luma_samples else None
            pose_quality_score, quality_components = compute_pose_quality(
                frames_data, primary_subject,
                mean_luma=mean_luma, subject_confidence=subject_confidence,
            )

            # Head movement + stance for the primary subject
            head_score = compute_head_movement(frames_data, primary_subject)
            if head_score is not None:
                clip.head_movement_score = head_score
            clip.stance = stances.get(primary_subject, "unknown")
            clip.selected_subject_id = primary_subject
            clip.subject_confidence = subject_confidence
            clip.pose_quality_score = pose_quality_score
            clip.pipeline_version = pipeline_version
            db.commit()
            stage_timings["classify"] = round(time.monotonic() - stage_start, 2)
            stage_start = time.monotonic()

            # Write keypoint JSON to S3 (all subjects, tagged with subject_id;
            # strikes carry confidence + a debug trace of their trigger values)
            result_s3_key = f"processed/{clip.clerk_user_id}/{clip_id}/keypoints.json"
            s3.put_object(
                Bucket=os.environ["S3_BUCKET_NAME"],
                Key=result_s3_key,
                Body=json.dumps({
                    "clip_id": clip_id,
                    "total_frames": frame_index,
                    "pipeline_version": pipeline_version,
                    "fps": fps,
                    "stride": stride,
                    "primary_subject_id": primary_subject,
                    "subject_confidence": subject_confidence,
                    "pose_quality": {"score": pose_quality_score, **quality_components},
                    "subjects": subject_summaries(frames_data),
                    "track_repair": repair_report,
                    "frames": frames_data,
                }),
                ContentType="application/json",
            )
            stage_timings["s3_write"] = round(time.monotonic() - stage_start, 2)
            stage_start = time.monotonic()

            # Persist ONLY the primary subject's confident strikes to Postgres —
            # all downstream metrics/feedback are computed for the selected
            # subject. Low-confidence strikes stay in the JSON, out of metrics.
            strike_rows = []
            for strike in strikes_data:
                if strike.get("subject_id") != primary_subject or strike.get("low_confidence"):
                    continue
                row = Strike(
                    job_id=job.id,
                    type=strike["type"],
                    timestamp_seconds=strike["timestamp_seconds"],
                    frame_index=strike["frame_index"],
                    subject_id=strike.get("subject_id"),
                    confidence=strike.get("confidence"),
                    arm_extension=strike.get("arm_extension"),
                    guard_dropped=strike.get("guard_dropped"),
                    peak_velocity=strike.get("peak_velocity"),
                    recovery_seconds=strike.get("recovery_seconds"),
                    hip_rotation=strike.get("hip_rotation"),
                    features=strike.get("features"),
                )
                db.add(row)
                strike_rows.append(row)
            db.commit()

            # Capture the athlete's identity sample (consent-gated, D2/D3:
            # athlete only). Persist the OSNet embedding so this clip enriches
            # the gallery — solo clips seed it, gallery-confirmed picks grow it.
            #   source: 'solo'   single meaningful subject (unambiguous)
            #           'auto'   gallery-picked the athlete among several
            # A heuristic pick among several with no gallery is NOT persisted —
            # it's a guess; it becomes a sample only on user confirmation
            # (manual select-subject) or when a gallery confirms it.
            try:
                if user_row is not None and getattr(user_row, "biometric_consent_at", None):
                    from models.identity_sample import IdentitySample
                    from services.reid_embedder import embed_subjects, EMBEDDING_MODEL

                    meaningful = [
                        s for s in subject_summaries(frames_data)
                        if s["frames"] >= 0.3 * max(len(frames_data), 1)
                    ]
                    is_solo = len(meaningful) == 1 and meaningful[0]["id"] == primary_subject
                    gallery_picked = subject_confidence >= GALLERY_OVERRIDE_MIN_CONF and athlete_embeddings
                    if is_solo or gallery_picked:
                        emb = athlete_embeddings.get(primary_subject)
                        if emb is None:
                            emb = embed_subjects(tmp_path, frames_data, [primary_subject],
                                                 s3_client=s3).get(primary_subject)
                        db.execute(delete(IdentitySample).where(IdentitySample.clip_id == clip.id))
                        db.add(IdentitySample(
                            user_id=user_row.id,
                            clip_id=clip.id,
                            subject_id=primary_subject,
                            pipeline_version=pipeline_version,
                            source="solo" if is_solo else "auto",
                            skeletal_stats=skeletal_stats(frames_data, primary_subject),
                            embedding=emb,
                            embedding_model=EMBEDDING_MODEL if emb else None,
                            confidence=subject_confidence,
                        ))
                        db.commit()
            except Exception as id_err:
                logger.warning(f"Identity sample capture failed (non-fatal): {id_err}")
                db.rollback()

            # Mark complete — user can view clip immediately
            job.status = "complete"
            job.progress = 100
            job.result_s3_key = result_s3_key
            job.completed_at = datetime.now(timezone.utc)
            job.heartbeat_at = datetime.now(timezone.utc)
            job.diagnostics = {
                "pipeline_version": pipeline_version,
                "model": model_name,
                "tier": tier,
                "fps": round(fps, 2),
                "stride": stride,
                "frames_total": total_frames,
                "frames_processed": processed,
                "subjects_detected": len(subject_ids),
                "primary_subject": primary_subject,
                "subject_confidence": subject_confidence,
                "strikes_total": len(strikes_data),
                "strikes_persisted": len(strike_rows),
                "strikes_low_confidence": sum(1 for s in strikes_data if s.get("low_confidence")),
                "pose_quality": {"score": pose_quality_score, **quality_components},
                "stage_timings": stage_timings,
                "attempt": job.attempt,
            }
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
            db.rollback()
            # If the clip/job was deleted mid-run (user deleted the clip — which
            # cascades to its job), there's nothing to update. Exit quietly so
            # Modal doesn't pointlessly retry a clip that no longer exists.
            fresh_job = db.execute(select(Job).where(Job.id == job_id)).scalar_one_or_none()
            if fresh_job is None:
                logger.warning(f"Job {job_id} no longer exists (clip deleted mid-process); aborting.")
                return
            fresh_job.status = "failed"
            fresh_job.error = str(e)
            fresh_job.error_code = e.code if isinstance(e, PipelineError) else "internal"
            db.commit()
            publish("failed", 0)
            # Deterministic input failures won't succeed on retry — exit
            # cleanly so Modal doesn't burn two more GPU runs on them.
            if isinstance(e, PipelineError) and e.code in ("decode_error", "no_person"):
                return
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


# head-movement + stance now live in services/clip_metrics.py (subject-aware,
# shared with the FastAPI subject-reselect endpoint).


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
                os.environ["DATABASE_URL"].replace("+asyncpg", ""),
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

# --- Stuck-job reaper ---

@app.function(
    image=image,
    secrets=[modal.Secret.from_name("southpaw-secrets")],
    gpu="T4",
    memory=2048,
    timeout=300,
    retries=1,
)
def embed_subject(clip_id: str, subject_id: int):
    """Re-embed ONE subject of a clip and attach the OSNet vector to that
    clip's identity sample. Spawned from the manual select-subject endpoint
    so a user's correction enriches their gallery (ReID block, Layer B
    Option 1).

    Privacy (D2/D3): this only ever embeds the subject the user claimed as
    themselves — never bystanders/opponents — and only with consent on file.
    Nothing is decoded or persisted for any other person.
    """
    import json as _json

    import boto3
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import sessionmaker

    from models.clip import Clip
    from models.job import Job
    from models.user import User
    from models.identity_sample import IdentitySample
    from services.reid_embedder import embed_subjects, EMBEDDING_MODEL

    s3 = boto3.client(
        "s3",
        aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        region_name=os.environ["AWS_REGION"],
    )
    engine = create_engine(
        os.environ["DATABASE_URL"].replace("+asyncpg", ""),
        pool_pre_ping=True, connect_args={"sslmode": "require"},
    )
    Session = sessionmaker(bind=engine)
    tmp_path = None

    with Session() as db:
        clip = db.execute(select(Clip).where(Clip.id == clip_id)).scalar_one_or_none()
        if clip is None:
            return
        user = db.execute(select(User).where(User.clerk_user_id == clip.clerk_user_id)).scalar_one_or_none()
        # Defensive re-check: never embed without consent on file.
        if user is None or getattr(user, "biometric_consent_at", None) is None:
            return
        sample = db.execute(
            select(IdentitySample).where(IdentitySample.clip_id == clip.id)
        ).scalar_one_or_none()
        if sample is None or sample.subject_id != subject_id:
            return  # selection changed again before this ran — let the latest win
        job = db.execute(
            select(Job).where(Job.clip_id == clip.id, Job.status == "complete")
        ).scalar_one_or_none()
        if job is None or not job.result_s3_key:
            return

        try:
            frames = _json.loads(
                s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"], Key=job.result_s3_key)["Body"].read()
            )["frames"]
            suffix = os.path.splitext(clip.s3_key)[-1] or ".mp4"
            tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            s3.download_fileobj(os.environ["S3_BUCKET_NAME"], clip.s3_key, tmp)
            tmp.close()
            tmp_path = tmp.name

            emb = embed_subjects(tmp_path, frames, [subject_id], s3_client=s3).get(subject_id)
            if emb is not None:
                sample.embedding = emb
                sample.embedding_model = EMBEDDING_MODEL
                db.commit()
        except Exception as e:
            logger.warning(f"embed_subject failed (non-fatal): {e}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)


reaper_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(["sqlalchemy", "psycopg2-binary", "redis"])
)


@app.function(
    image=reaper_image,
    secrets=[modal.Secret.from_name("southpaw-secrets")],
    memory=512,
    timeout=120,
    schedule=modal.Period(minutes=5),
)
def reap_stale_jobs():
    """
    Fail jobs that will never finish, so users don't stare at a frozen
    progress bar:
      - 'processing' with a heartbeat older than STALE_HEARTBEAT_MINUTES
        (container died past Modal's retries, network partition, etc.)
      - 'queued' older than STALE_QUEUED_MINUTES (spawn was lost).
    Publishes a 'failed' event so any open SSE stream resolves. Failed jobs
    are safe to re-run: run_inference wipes its own strikes at start.
    """
    import json as json_lib
    import redis as redis_lib
    from sqlalchemy import create_engine, text

    engine = create_engine(
        os.environ["DATABASE_URL"].replace("+asyncpg", ""),
        pool_pre_ping=True,
        connect_args={"sslmode": "require"},
    )
    redis_client = redis_lib.from_url(os.environ["REDIS_URL"], ssl_cert_reqs=None)

    with engine.begin() as conn:
        rows = conn.execute(text(f"""
            UPDATE jobs SET
                status = 'failed',
                error = 'Processing timed out — please retry, or try a shorter clip',
                error_code = 'timeout'
            WHERE (
                status = 'processing'
                AND heartbeat_at IS NOT NULL
                AND heartbeat_at < now() - interval '{STALE_HEARTBEAT_MINUTES} minutes'
            ) OR (
                status = 'queued'
                AND created_at < now() - interval '{STALE_QUEUED_MINUTES} minutes'
            )
            RETURNING id
        """)).fetchall()

    for (job_id,) in rows:
        logger.warning(f"Reaped stale job {job_id}")
        try:
            redis_client.publish(
                f"job:{job_id}", json_lib.dumps({"status": "failed", "progress": 0})
            )
        except Exception as pub_err:
            logger.warning(f"Could not publish reap event for job {job_id}: {pub_err}")
