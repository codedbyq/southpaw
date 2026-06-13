"""OSNet-AIN person-ReID embedder for the athlete gallery.

Cross-clip identity needs a purpose-trained ReID model, not ImageNet features
(measured: ImageNet picks the wrong person across clips; OSNet-AIN MSMT17
ranks the athlete correctly, 4/4 leave-one-out vs negatives). This wraps
torchreid's OSNet and produces a normalized centroid per tracked subject from
pose-derived crops.

Used only for the gallery (cross-clip recognition); within-clip track repair
keeps its lighter ResNet18 (services/appearance.py), which was proven enough
for the within-clip job. Weights load from S3 (uploaded once) and cache in the
container — gdrive is too flaky for production cold starts.

Heavy imports (torch/torchreid) are lazy so this module is importable in the
FastAPI process (which never embeds) without pulling the ReID stack.
"""

import os

EMBEDDING_MODEL = "osnet_ain_x1_0_msmt17"
WEIGHTS_S3_KEY = "models/osnet_ain_x1_0_msmt17.pt"
_WEIGHTS_CACHE = "/tmp/osnet_ain_x1_0_msmt17.pt"
MIN_KEYPOINT_CONF = 0.3
SAMPLE_EVERY_S = 0.7
MIN_CROP_PX = (24, 48)
CROP_MARGIN = 0.07

_extractor = None


def _ensure_weights(s3_client=None):
    if os.path.exists(_WEIGHTS_CACHE):
        return _WEIGHTS_CACHE
    import boto3
    s3 = s3_client or boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    s3.download_file(os.environ["S3_BUCKET_NAME"], WEIGHTS_S3_KEY, _WEIGHTS_CACHE)
    return _WEIGHTS_CACHE


def get_extractor(s3_client=None):
    """Lazily build the cached OSNet FeatureExtractor (one per container)."""
    global _extractor
    if _extractor is None:
        import torch
        from torchreid.reid.utils import FeatureExtractor
        device = ("cuda" if torch.cuda.is_available()
                  else "mps" if torch.backends.mps.is_available() else "cpu")
        _extractor = FeatureExtractor(
            model_name="osnet_ain_x1_0",
            model_path=_ensure_weights(s3_client),
            device=device,
            verbose=False,
        )
    return _extractor


def _subject_boxes(frames, subject_ids):
    """{subject_id: [(t, x0, y0, x1, y1)]} from keypoints (normalized)."""
    wanted = set(subject_ids)
    boxes = {sid: [] for sid in wanted}
    for f in frames:
        t = f.get("timestamp", 0.0)
        for sk in f.get("skeletons", []):
            if sk.get("id") not in wanted:
                continue
            pts = [(k["x"], k["y"]) for k in sk.get("keypoints", []) if k["visibility"] > MIN_KEYPOINT_CONF]
            if len(pts) < 8:
                continue
            xs, ys = zip(*pts)
            boxes[sk["id"]].append((t, min(xs), min(ys), max(xs), max(ys)))
    return boxes


def embed_subjects(video_path, frames, subject_ids, s3_client=None):
    """Return {subject_id: normalized_centroid(list[float])} for the given
    post-repair subjects, sampling crops from the video. Subjects with too few
    usable crops are omitted."""
    import cv2
    import numpy as np

    extractor = get_extractor(s3_client)
    boxes = _subject_boxes(frames, subject_ids)

    # plan one decode: rounded-t -> [(sid, box)], sampled per subject
    wanted = {}
    for sid, blist in boxes.items():
        next_t = -1e9
        for (t, x0, y0, x1, y1) in blist:
            if t - next_t < SAMPLE_EVERY_S:
                continue
            next_t = t
            wanted.setdefault(round(t, 2), []).append((sid, (x0, y0, x1, y1)))

    crops_by_sid = {sid: [] for sid in subject_ids}
    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    for t in sorted(wanted):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, frame = cap.read()
        if not ok:
            continue
        H, W = frame.shape[:2]
        for sid, (x0, y0, x1, y1) in wanted[t]:
            mx, my = CROP_MARGIN * (x1 - x0), CROP_MARGIN * (y1 - y0)
            a, b = max(0, int((x0 - mx) * W)), min(W, int((x1 + mx) * W))
            c, d = max(0, int((y0 - my) * H)), min(H, int((y1 + my) * H))
            if b - a < MIN_CROP_PX[0] or d - c < MIN_CROP_PX[1]:
                continue
            crops_by_sid[sid].append(cv2.cvtColor(frame[c:d, a:b], cv2.COLOR_BGR2RGB))
    cap.release()

    out = {}
    for sid, crops in crops_by_sid.items():
        if not crops:
            continue
        feats = extractor(crops).cpu().numpy()
        feats = feats / np.linalg.norm(feats, axis=1, keepdims=True)
        c = feats.mean(axis=0)
        out[sid] = (c / (np.linalg.norm(c) or 1.0)).tolist()
    return out
