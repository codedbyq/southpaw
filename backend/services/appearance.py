"""Appearance identity layer — embeddings for track repair (ReID block).

Pose geometry cannot adjudicate identity (measured: limb proportions shift
0.064 across a known swap vs 0.30 noise; torso-scale changepoints are swamped
by genuine depth motion; see scripts/appearance_probe.py). Appearance can:
a vanilla ImageNet ResNet18 on pose-derived crops gives same-person distances
<= 0.04 across 100s and cross-person distances >= 0.097 on the fixtures.

Two consumers in services/track_repair.py:
- drift splitting: a sustained changepoint in a track's embedding profile
  means the tracker silently switched people mid-track -> split there
- stitch adjudication: a geometric merge candidate must also look like the
  same person, or it is rejected (measured failure: the pose-only stitcher
  re-merged a fighter onto the pad holder across a crossover)

Privacy boundary (spec D2/D3): embeddings are computed transiently for
repair and discarded. Nothing here persists biometric data; the consented
athlete gallery is a separate, gated concern.
"""

import json
from pathlib import Path

APPEARANCE_VERSION = "app-1"

# Calibrated on fixtures (scripts/appearance_probe.py): same person <= 0.04
# even 100s apart; different person >= 0.097.
SPLIT_THRESHOLD = 0.07      # sustained pre/post distance above this = swap
STITCH_MAX_DISTANCE = 0.07  # merge candidates above this are different people
BUCKET_SECONDS = 4.0        # embedding profile granularity
SAMPLE_EVERY_S = 0.5        # crop sampling rate per track
MIN_CROP_PX = (24, 48)      # (w, h) floor — smaller crops embed noise
CROP_MARGIN = 0.07


def _norm(v):
    import numpy as np
    n = float(np.linalg.norm(v))
    return v / n if n > 0 else v


class Embedder:
    """Lazy ResNet18 embedding of RGB person crops (mps/cuda/cpu)."""

    def __init__(self):
        self._net = None
        self._prep = None
        self._device = None

    def _ensure(self):
        if self._net is not None:
            return
        import torch
        import torchvision.models as tvm
        import torchvision.transforms as T
        self._device = ("cuda" if torch.cuda.is_available()
                        else "mps" if torch.backends.mps.is_available() else "cpu")
        net = tvm.resnet18(weights=tvm.ResNet18_Weights.IMAGENET1K_V1)
        net.fc = torch.nn.Identity()
        self._net = net.eval().to(self._device)
        self._prep = T.Compose([
            T.ToTensor(), T.Resize((256, 128)),
            T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ])

    def embed_batch(self, rgb_crops):
        import torch
        self._ensure()
        if not rgb_crops:
            return []
        with torch.no_grad():
            batch = torch.stack([self._prep(c) for c in rgb_crops]).to(self._device)
            out = self._net(batch).cpu().numpy()
        return [_norm(e) for e in out]


class AppearanceIndex:
    """Per-track, time-bucketed embedding centroids."""

    def __init__(self, bucket_s: float = BUCKET_SECONDS):
        self.bucket_s = bucket_s
        self._buckets: dict = {}   # (track_id, bucket_i) -> [embeddings]

    def add(self, track_id, t, embedding):
        key = (track_id, int(t / self.bucket_s))
        self._buckets.setdefault(key, []).append(embedding)

    def centroid(self, track_id, t0=None, t1=None):
        import numpy as np
        embs = []
        for (tid, bi), es in self._buckets.items():
            if tid != track_id:
                continue
            b_mid = (bi + 0.5) * self.bucket_s
            if t0 is not None and b_mid < t0:
                continue
            if t1 is not None and b_mid > t1:
                continue
            embs.extend(es)
        if not embs:
            return None
        return _norm(np.mean(embs, axis=0))

    def windows(self, track_id):
        """Time-ordered (t_mid, centroid, n_samples) per bucket."""
        import numpy as np
        out = []
        for (tid, bi), es in sorted(self._buckets.items(), key=lambda kv: kv[0][1]):
            if tid != track_id or not es:
                continue
            out.append(((bi + 0.5) * self.bucket_s, _norm(np.mean(es, axis=0)), len(es)))
        return out

    def tracks(self):
        return sorted({tid for tid, _ in self._buckets})

    def remap(self, resolver):
        """New index with track ids passed through resolver(sid, t_mid) —
        keeps the index aligned with frames after splits are applied."""
        out = AppearanceIndex(self.bucket_s)
        for (tid, bi), es in self._buckets.items():
            t_mid = (bi + 0.5) * self.bucket_s
            new_tid = resolver(tid, t_mid)
            for e in es:
                out.add(new_tid, t_mid, e)
        return out


def distance(a, b):
    import numpy as np
    if a is None or b is None:
        return None
    return 1.0 - float(np.dot(a, b))


def _track_boxes(frames, min_conf=0.3):
    """{track_id: [(t, x0, y0, x1, y1)]} from keypoints (normalized coords)."""
    boxes = {}
    for f in frames:
        t = f.get("timestamp", 0.0)
        for sk in f.get("skeletons", []):
            kps = sk.get("keypoints", [])
            pts = [(k["x"], k["y"]) for k in kps if k["visibility"] > min_conf]
            if len(pts) < 8:
                continue
            xs, ys = zip(*pts)
            boxes.setdefault(sk["id"], []).append((t, min(xs), min(ys), max(xs), max(ys)))
    return boxes


def build_index_from_video(video_path, frames, sample_every_s: float = SAMPLE_EVERY_S,
                           embedder: Embedder | None = None) -> AppearanceIndex:
    """Offline mode: sample crops for every track from the video file.
    (The Modal pipeline collects crops in-loop instead — same index shape.)"""
    import cv2
    embedder = embedder or Embedder()
    index = AppearanceIndex()
    boxes = _track_boxes(frames)

    # plan: per track, sample timestamps; group by source frame for one decode
    wanted = {}  # rounded t -> [(track_id, box)]
    for tid, blist in boxes.items():
        next_t = -1e9
        for (t, x0, y0, x1, y1) in blist:
            if t - next_t < sample_every_s:
                continue
            next_t = t
            wanted.setdefault(round(t, 2), []).append((tid, (x0, y0, x1, y1)))

    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    pending_crops, pending_meta = [], []
    for t in sorted(wanted):
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, frame = cap.read()
        if not ok:
            continue
        H, W = frame.shape[:2]
        for tid, (x0, y0, x1, y1) in wanted[t]:
            mx, my = CROP_MARGIN * (x1 - x0), CROP_MARGIN * (y1 - y0)
            a, b = max(0, int((x0 - mx) * W)), min(W, int((x1 + mx) * W))
            c, d = max(0, int((y0 - my) * H)), min(H, int((y1 + my) * H))
            if b - a < MIN_CROP_PX[0] or d - c < MIN_CROP_PX[1]:
                continue
            pending_crops.append(cv2.cvtColor(frame[c:d, a:b], cv2.COLOR_BGR2RGB))
            pending_meta.append((tid, t))
            if len(pending_crops) >= 64:
                for (tid2, t2), e in zip(pending_meta, embedder.embed_batch(pending_crops)):
                    index.add(tid2, t2, e)
                pending_crops, pending_meta = [], []
    for (tid2, t2), e in zip(pending_meta, embedder.embed_batch(pending_crops)):
        index.add(tid2, t2, e)
    cap.release()
    return index


def find_drift_splits(index: AppearanceIndex, min_track_s: float = 10.0,
                      threshold: float = SPLIT_THRESHOLD) -> dict:
    """{track_id: [split_t, ...]} — sustained appearance changepoints.

    A candidate is the boundary between adjacent buckets whose centroids
    diverge; it is confirmed only if the aggregate pre vs post centroids
    (whole sides, not just the adjacent windows) also diverge — a transient
    occlusion pollutes one bucket, a real swap shifts the whole tail."""
    splits = {}
    for tid in index.tracks():
        wins = index.windows(tid)
        if len(wins) < 3 or (wins[-1][0] - wins[0][0]) < min_track_s:
            continue
        found = []
        for i in range(len(wins) - 1):
            (t_a, c_a, n_a), (t_b, c_b, n_b) = wins[i], wins[i + 1]
            # sparse buckets (partially-visible background people, tiny crops)
            # embed noisily — splitting needs dense evidence on both sides
            if n_a < 5 or n_b < 5:
                continue
            d = distance(c_a, c_b)
            if d is None or d < threshold:
                continue
            boundary = (t_a + t_b) / 2
            pre = index.centroid(tid, None, boundary)
            post = index.centroid(tid, boundary, None)
            d_global = distance(pre, post)
            if d_global is not None and d_global >= threshold:
                if not found or boundary - found[-1] > 2 * BUCKET_SECONDS:
                    found.append(round(boundary, 2))
        if found:
            splits[tid] = found
    return splits


def save_index(index: AppearanceIndex, path):
    """Debug/fixture persistence of bucket centroids (NOT a production store —
    repair embeddings are transient by design)."""
    import numpy as np
    out = {}
    for (tid, bi), es in index._buckets.items():
        out.setdefault(str(tid), {})[str(bi)] = _norm(np.mean(es, axis=0)).tolist()
    Path(path).write_text(json.dumps({"bucket_s": index.bucket_s, "tracks": out}))
