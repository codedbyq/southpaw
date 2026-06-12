"""Tracking-quality evaluation over the tracking fixtures (and core clips).

Structural metrics need no labels: fragmentation (tracklets/minute, mean
tracklet lifespan), churn (id births per 10s), and largest-subject coverage.
With a <name>.truth.json (see golden/regression/tracking/README.md), adds
direct identity metrics: fighter id-consistency across human checkpoints and
fighter coverage.

Run before and after track repair — the same metrics measure the fix.

Usage:
    cd backend && ./venv/bin/python scripts/eval_tracking.py             # fixtures
    cd backend && ./venv/bin/python scripts/eval_tracking.py --core     # + core clips (pass-through baseline)
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.strike_classifier import MIN_KEYPOINT_CONF, _mid

BASE = Path(__file__).resolve().parent.parent
FIXTURES = BASE / "golden" / "regression" / "tracking"
CORE = BASE / "golden" / "core"

MEANINGFUL_PRESENCE_S = 2.0


def subject_spans(frames):
    """{subject_id: {"first": t, "last": t, "n": frames_present}}"""
    spans = {}
    for f in frames:
        t = f.get("timestamp", 0.0)
        for sk in f.get("skeletons", []):
            sid = sk.get("id")
            s = spans.setdefault(sid, {"first": t, "last": t, "n": 0})
            s["last"] = t
            s["n"] += 1
    return spans


def structural_metrics(frames):
    if not frames:
        return None
    duration = frames[-1].get("timestamp", 0.0) - frames[0].get("timestamp", 0.0)
    if duration <= 0:
        return None
    spans = subject_spans(frames)
    lifespans = [s["last"] - s["first"] for s in spans.values()]
    meaningful = [sid for sid, s in spans.items() if s["last"] - s["first"] >= MEANINGFUL_PRESENCE_S]
    largest = max(spans.items(), key=lambda kv: kv[1]["n"]) if spans else (None, None)
    largest_coverage = largest[1]["n"] / len(frames) if spans else 0.0

    # churn: new ids appearing per 10s window
    births = sorted(s["first"] for s in spans.values())
    return {
        "duration_s": round(duration, 1),
        "subjects_total": len(spans),
        "subjects_meaningful": len(meaningful),
        "tracklets_per_min": round(len(spans) / (duration / 60), 1),
        "mean_tracklet_s": round(sum(lifespans) / len(lifespans), 2) if lifespans else None,
        "largest_subject": largest[0],
        "largest_coverage": round(largest_coverage, 3),
        "id_births_per_10s": round(len(births) / (duration / 10), 2),
    }


def _fighter_at(frames, t, region):
    """Resolve a truth checkpoint to a skeleton id: the subject whose mid-hip
    x best matches the labeled horizontal region at time t."""
    frame = min(frames, key=lambda f: abs(f.get("timestamp", 0.0) - t))
    if abs(frame.get("timestamp", 0.0) - t) > 1.0:
        return None
    candidates = []
    for sk in frame.get("skeletons", []):
        kps = sk.get("keypoints", [])
        if len(kps) < 17:
            continue
        lh, rh = kps[11], kps[12]
        if lh["visibility"] <= MIN_KEYPOINT_CONF or rh["visibility"] <= MIN_KEYPOINT_CONF:
            continue
        candidates.append((sk["id"], _mid(lh, rh)["x"]))
    if not candidates:
        return None
    target = {"left": 0.2, "center": 0.5, "right": 0.8}.get(region, 0.5)
    return min(candidates, key=lambda c: abs(c[1] - target))[0]


def truth_metrics(frames, truth):
    cps = truth.get("checkpoints", [])
    resolved = [(cp["t"], _fighter_at(frames, cp["t"], cp["fighter"])) for cp in cps]
    resolved = [(t, sid) for t, sid in resolved if sid is not None]
    if not resolved:
        return {"checkpoints_resolved": 0}
    ids = [sid for _, sid in resolved]
    from collections import Counter
    dominant, dom_n = Counter(ids).most_common(1)[0]
    return {
        "checkpoints_resolved": len(resolved),
        "fighter_ids_seen": sorted(set(ids)),
        "id_consistency": round(dom_n / len(resolved), 2),  # 1.0 = one track covers every checkpoint
        "dominant_id": dominant,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--core", action="store_true", help="also report core clips (pass-through baseline)")
    args = ap.parse_args()

    targets = sorted(FIXTURES.glob("*.keypoints.json"))
    if args.core:
        targets += sorted(CORE.glob("*.keypoints.json"))

    for kp_path in targets:
        name = kp_path.name.replace(".keypoints.json", "")
        frames = json.loads(kp_path.read_text())["frames"]
        m = structural_metrics(frames)
        if m is None:
            continue
        tier = "FIXTURE" if kp_path.parent == FIXTURES else "core"
        print(f"\n[{tier}] {name}")
        print(f"  {m['duration_s']}s · {m['subjects_total']} ids ({m['subjects_meaningful']} meaningful) · "
              f"{m['tracklets_per_min']}/min · mean lifespan {m['mean_tracklet_s']}s · "
              f"births {m['id_births_per_10s']}/10s")
        print(f"  largest subject {m['largest_subject']} covers {m['largest_coverage']:.0%} of frames")
        truth_path = kp_path.with_name(f"{name}.truth.json")
        if truth_path.exists():
            tm = truth_metrics(frames, json.loads(truth_path.read_text()))
            print(f"  TRUTH: {tm}")


if __name__ == "__main__":
    main()
