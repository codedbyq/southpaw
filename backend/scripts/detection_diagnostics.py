"""Per-detection kinematic diagnostics for classifier tuning.

Replays the classifier over a keypoints JSON (like golden_eval, no GPU) and
prints body-relative features per detection — the signals that separate real
strikes from footwork/keypoint-error false positives:

  v_rel     end-effector velocity relative to mid-hip (strides move limbs too,
            but kicks/punches move them much faster than the body)
  v_body    mid-hip velocity (high = detection fired mid-stride/skip)
  v_other   other ankle's velocity, kicks only (high = both feet moving =
            skip/switch-step, not a kick — the support foot should be planted)
  chamber   knee height below hip in torso-lengths, kicks only (kicks chamber
            the knee up; steps don't)
  ext       arm extension, punches only (> ~1.25 torso-lengths is anatomically
            impossible -> wrist keypoint excursion, e.g. snapping to the bag)

Usage:  cd backend && ./venv/bin/python scripts/detection_diagnostics.py <keypoints.json> [stance] [clip_type]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.strike_classifier import (
    classify_subject_strikes, _build_series, _window_start, _limb_velocity,
    torso_length, _dist, _mid,
)

IMPOSSIBLE_EXTENSION = 1.25  # torso-lengths; arm length ≈ 1 torso


def main(path: str, stance: str = "orthodox", clip_type: str = "bag"):
    data = json.load(open(path))
    frames, sid = data["frames"], data["primary_subject_id"]
    strikes = [s for s in classify_subject_strikes(frames, sid, stance=stance, clip_type=clip_type)
               if not s["low_confidence"]]
    series = _build_series(frames, sid)
    torso = torso_length(series)

    def at(ts):
        return min(range(len(series)), key=lambda k: abs(series[k]["t"] - ts))

    def velocities(s):
        i = at(s["timestamp_seconds"])
        j = _window_start(series, i)
        if j is None:
            return None
        dt = series[i]["t"] - series[j]["t"]
        cur_h = _mid(series[i]["kps"][11], series[i]["kps"][12])
        past_h = _mid(series[j]["kps"][11], series[j]["kps"][12])
        v_body = _dist(cur_h, past_h) / torso / dt

        is_kick = "kick" in s["type"]
        if is_kick:
            is_left = s["type"] == "lead_kick" if stance == "orthodox" else s["type"] != "lead_kick"
            end, knee, hip = (15, 13, 11) if is_left else (16, 14, 12)
            other = 16 if is_left else 15
        else:
            # striking wrist: highest-velocity wrist at the peak
            v9, _, _ = _limb_velocity(series, i, j, 9, torso)
            v10, _, _ = _limb_velocity(series, i, j, 10, torso)
            end = 9 if v9 >= v10 else 10
            knee = hip = other = None

        kps_i, kps_j = series[i]["kps"], series[j]["kps"]
        rel_cur = {"x": kps_i[end]["x"] - cur_h["x"], "y": kps_i[end]["y"] - cur_h["y"]}
        rel_past = {"x": kps_j[end]["x"] - past_h["x"], "y": kps_j[end]["y"] - past_h["y"]}
        v_rel = _dist(rel_cur, rel_past) / torso / dt

        out = {"v_rel": round(v_rel, 2), "v_body": round(v_body, 2)}
        if is_kick:
            v_other, _, _ = _limb_velocity(series, i, j, other, torso)
            out["v_other"] = round(v_other, 2)
            out["chamber"] = round((kps_i[knee]["y"] - kps_i[hip]["y"]) / torso, 2)
        return out

    print(f"{len(strikes)} persisted detections | torso {torso:.4f} | fps {data.get('fps'):.1f}\n")
    print(f"{'t':>6} {'type':<16} {'v_peak':>6} {'v_rel':>6} {'v_body':>6} {'v_other':>7} {'chamber':>7} {'ext':>6} {'conf':>5}  flags")
    flagged = 0
    for s in strikes:
        d = velocities(s) or {}
        ext = s.get("arm_extension")
        flags = []
        if ext is not None and ext > IMPOSSIBLE_EXTENSION:
            flags.append("EXT!")
        if d.get("v_other", 0) > 2.0:
            flags.append("BOTH-FEET!")
        if d.get("v_body", 0) > 1.5:
            flags.append("moving")
        if flags and flags != ["moving"]:
            flagged += 1
        print(f"{s['timestamp_seconds']:>6.1f} {s['type']:<16} {s['peak_velocity']:>6.2f} "
              f"{d.get('v_rel', '—'):>6} {d.get('v_body', '—'):>6} {str(d.get('v_other', '—')):>7} "
              f"{str(d.get('chamber', '—')):>7} {str(ext if ext is not None else '—'):>6} {s['confidence']:>5}  {' '.join(flags)}")

    ts = sorted(s["timestamp_seconds"] for s in strikes)
    gaps = [b - a for a, b in zip(ts, ts[1:])]
    if gaps:
        sub = sum(1 for g in gaps if g < 0.4)
        print(f"\nhard-flagged (impossible extension / both feet fast): {flagged}/{len(strikes)}")
        print(f"inter-detection gaps < 0.4s: {sub}/{len(gaps)} | median gap {sorted(gaps)[len(gaps)//2]:.2f}s")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(*sys.argv[1:4])
