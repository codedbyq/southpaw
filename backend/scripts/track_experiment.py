"""Tracker experiment: what do native ByteTrack / BoT-SORT give us for free?

Reprocesses fixture clips locally (MPS/CPU) with Ultralytics-native tracking
variants and writes keypoints JSONs comparable to the pipeline's, so
eval_tracking can score them against the stored production baselines
(supervision-ByteTrack). Informs spec D11 (tracker migration) and how much
work is left for the stitcher/appearance phases.

Variants:
    bt        bytetrack.yaml defaults (track_buffer 30)
    bt-long   bytetrack with track_buffer 120 (~4s of occlusion tolerance)
    bs        botsort.yaml defaults (camera-motion compensation, no ReID)
    bs-reid   botsort with native appearance ReID (with_reid: true)

Usage:
    cd backend && ./venv/bin/python scripts/track_experiment.py <clip_id8> [max_seconds]
Outputs: /tmp/track_exp/<clip>-<variant>.keypoints.json
"""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

OUT = Path("/tmp/track_exp")
TRACKER_DIR = OUT / "trackers"

VARIANTS = {
    "bt": ("bytetrack", {}),
    "bt-long": ("bytetrack", {"track_buffer": 120}),
    "bs": ("botsort", {}),
    "bs-reid": ("botsort", {"with_reid": True}),
}

BASE_CFG = {
    "bytetrack": {
        "tracker_type": "bytetrack",
        "track_high_thresh": 0.25, "track_low_thresh": 0.1,
        "new_track_thresh": 0.25, "track_buffer": 30, "match_thresh": 0.8,
        "fuse_score": True,
    },
    "botsort": {
        "tracker_type": "botsort",
        "track_high_thresh": 0.25, "track_low_thresh": 0.1,
        "new_track_thresh": 0.25, "track_buffer": 30, "match_thresh": 0.8,
        "fuse_score": True,
        "gmc_method": "sparseOptFlow",
        "proximity_thresh": 0.5, "appearance_thresh": 0.25,
        "with_reid": False, "model": "auto",
    },
}


def fetch_video(clip_id8: str) -> tuple[Path, str]:
    import asyncio
    import boto3
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy import text

    async def lookup():
        eng = create_async_engine(os.environ["DATABASE_URL"])
        async with eng.connect() as c:
            row = (await c.execute(text(
                "select id::text, s3_key, filename from clips where id::text like :p"),
                {"p": clip_id8 + "%"})).fetchone()
        await eng.dispose()
        return row

    row = asyncio.run(lookup())
    if not row:
        sys.exit(f"no clip matching {clip_id8}")
    clip_id, s3_key, filename = row
    dest = OUT / f"{clip_id[:8]}-{filename}"
    if not dest.exists():
        OUT.mkdir(parents=True, exist_ok=True)
        boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1")) \
            .download_file(os.environ["S3_BUCKET_NAME"], s3_key, str(dest))
    return dest, clip_id[:8]


def write_tracker_yaml(variant: str) -> Path:
    base, overrides = VARIANTS[variant]
    cfg = dict(BASE_CFG[base], **overrides)
    TRACKER_DIR.mkdir(parents=True, exist_ok=True)
    path = TRACKER_DIR / f"{variant}.yaml"
    path.write_text("\n".join(f"{k}: {str(v).lower() if isinstance(v, bool) else v}"
                              for k, v in cfg.items()) + "\n")
    return path


def run_variant(video: Path, clip8: str, variant: str, max_seconds: float | None):
    import torch
    from ultralytics import YOLO

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = YOLO("yolo11s-pose.pt")
    tracker_yaml = write_tracker_yaml(variant)

    import cv2
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    cap.release()
    stride = 2 if fps > 40 else 1
    eff_fps = fps / stride

    frames_out = []
    frame_idx = 0
    for result in model.track(source=str(video), stream=True, persist=True,
                              tracker=str(tracker_yaml), device=device,
                              vid_stride=stride, imgsz=736, verbose=False):
        t = frame_idx * stride / fps
        if max_seconds is not None and t > max_seconds:
            break
        skeletons = []
        if result.keypoints is not None and result.boxes is not None and len(result.keypoints) > 0:
            ids = result.boxes.id
            h, w = result.orig_shape
            for k in range(len(result.keypoints)):
                tid = int(ids[k]) if ids is not None else k
                kps = result.keypoints.xy[k].cpu().numpy()
                conf = result.keypoints.conf[k].cpu().numpy() if result.keypoints.conf is not None else None
                skeletons.append({
                    "id": tid,
                    "keypoints": [
                        {"x": float(kps[i][0] / w), "y": float(kps[i][1] / h),
                         "visibility": float(conf[i]) if conf is not None else 0.0}
                        for i in range(len(kps))
                    ],
                })
        frames_out.append({"frame": frame_idx * stride, "timestamp": round(t, 4), "skeletons": skeletons})
        frame_idx += 1

    out_path = OUT / f"{clip8}-{variant}.keypoints.json"
    out_path.write_text(json.dumps({"frames": frames_out, "fps": fps, "variant": variant}))
    return out_path


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    clip8 = sys.argv[1]
    max_seconds = float(sys.argv[2]) if len(sys.argv) > 2 else None

    video, clip8 = fetch_video(clip8)
    print(f"video: {video.name} (limit: {max_seconds or 'full'}s)")

    from scripts.eval_tracking import structural_metrics
    from services.track_repair import apply_repair

    for variant in VARIANTS:
        try:
            out = run_variant(video, clip8, variant, max_seconds)
        except Exception as e:
            print(f"  {variant}: FAILED ({e})")
            continue
        frames = json.loads(out.read_text())["frames"]
        m = structural_metrics(frames)
        line = (f"  {variant:<8} {m['subjects_total']} ids · {m['tracklets_per_min']}/min · "
                f"lifespan {m['mean_tracklet_s']}s · largest covers {m['largest_coverage']:.0%}")
        rep = apply_repair(frames)
        m2 = structural_metrics(frames)
        line += f"   [+stitch: {m2['subjects_total']} ids, largest {m2['largest_coverage']:.0%}]"
        print(line)


if __name__ == "__main__":
    main()
