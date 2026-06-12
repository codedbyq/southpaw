"""Appearance identity probe: embed person crops from a track's time segments
and report pairwise cosine distances between segment centroids.

The measurement that justified the appearance phase (ReID block):
- drift fixture (IMG_6336 track 1, swap at 67.7s): same-person segments
  0.022 apart; across the swap 0.097-0.111 — a 4-5x separation
- long-range same-person baseline (IMG_7678 track 1, 100s span): <= 0.04
=> within-track changepoint threshold ~0.06-0.07 has margin on both sides,
   using a vanilla ImageNet ResNet18 on pose-derived crops (256x128).

Usage:
    cd backend && ./venv/bin/python scripts/appearance_probe.py \
        <clip_id8> <keypoints.json> <track_id> <t0,t1> <t0,t1> [...]
"""

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.strike_classifier import MIN_KEYPOINT_CONF
from scripts.track_experiment import fetch_video

CROP_MARGIN = 0.07
SAMPLES_PER_SEGMENT = 24


def track_boxes(frames, track_id):
    boxes = {}
    for f in frames:
        for sk in f.get("skeletons", []):
            if sk.get("id") != track_id:
                continue
            pts = [(k["x"], k["y"]) for k in sk["keypoints"] if k["visibility"] > MIN_KEYPOINT_CONF]
            if len(pts) < 8:
                continue
            xs, ys = zip(*pts)
            boxes[round(f["timestamp"], 2)] = (min(xs), min(ys), max(xs), max(ys))
    return boxes


def make_embedder():
    import torch
    import torchvision.models as tvm
    import torchvision.transforms as T

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    net = tvm.resnet18(weights=tvm.ResNet18_Weights.IMAGENET1K_V1)
    net.fc = torch.nn.Identity()
    net.eval().to(device)
    prep = T.Compose([T.ToTensor(), T.Resize((256, 128)),
                      T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])])

    def embed(rgb_crop):
        with torch.no_grad():
            e = net(prep(rgb_crop).unsqueeze(0).to(device)).squeeze().cpu().numpy()
        return e / np.linalg.norm(e)
    return embed


def segment_centroid(cap, fps, boxes, embed, t0, t1):
    import cv2
    embs = []
    for t in np.linspace(t0, t1, SAMPLES_PER_SEGMENT):
        near = min(boxes.keys(), key=lambda bt: abs(bt - t))
        if abs(near - t) > 0.5:
            continue
        x0, y0, x1, y1 = boxes[near]
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(near * fps))
        ok, frame = cap.read()
        if not ok:
            continue
        H, W = frame.shape[:2]
        mx, my = CROP_MARGIN * (x1 - x0), CROP_MARGIN * (y1 - y0)
        a, b = max(0, int((x0 - mx) * W)), min(W, int((x1 + mx) * W))
        c, d = max(0, int((y0 - my) * H)), min(H, int((y1 + my) * H))
        if b - a < 20 or d - c < 40:
            continue
        embs.append(embed(cv2.cvtColor(frame[c:d, a:b], cv2.COLOR_BGR2RGB)))
    if not embs:
        return None, 0
    cnt = np.mean(embs, axis=0)
    return cnt / np.linalg.norm(cnt), len(embs)


def main():
    import cv2
    if len(sys.argv) < 5:
        sys.exit(__doc__)
    clip8, kp_path, track_id = sys.argv[1], sys.argv[2], int(sys.argv[3])
    segments = [tuple(float(x) for x in s.split(",")) for s in sys.argv[4:]]

    video, _ = fetch_video(clip8)
    frames = json.loads(Path(kp_path).read_text())["frames"]
    boxes = track_boxes(frames, track_id)
    embed = make_embedder()
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)

    cents = []
    for (t0, t1) in segments:
        c, n = segment_centroid(cap, fps, boxes, embed, t0, t1)
        print(f"segment {t0}-{t1}s: {n} crops")
        cents.append(((t0, t1), c))
    for i in range(len(cents)):
        for j in range(i + 1, len(cents)):
            (s1, c1), (s2, c2) = cents[i], cents[j]
            if c1 is None or c2 is None:
                continue
            print(f"cosine distance {s1} <-> {s2}: {1 - float(np.dot(c1, c2)):.4f}")


if __name__ == "__main__":
    main()
