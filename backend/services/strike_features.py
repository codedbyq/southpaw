"""Trajectory feature extraction — schema v1 (docs/pipeline-evolution.md Part 2).

For every detected strike, computes a body-frame trajectory record over a
window around the velocity peak and attaches it as strike["features"]. Pure
Python, deterministic, replayable offline by the golden harness — which is the
point: features are stored at processing time so every label collected later
becomes an (features, label) training row with no reprocessing.

Coordinates are body-centric: origin mid-hip, x flipped so the fighter's
facing direction is +x (kills camera left/right variance), distances in
torso-lengths (kills camera distance variance). Time is resampled to
N_SAMPLES points (kills 30/60fps variance).

Purely additive: nothing here affects detection or naming. FEATURES_VERSION
is stamped into every record; bump on any semantic change.
"""

import math

from services.strike_classifier import (
    MIN_KEYPOINT_CONF, LEFT_ARM, RIGHT_ARM, LEFT_LEG, RIGHT_LEG,
    _build_series, _dist, _mid, torso_length,
)

FEATURES_VERSION = "features-1"

WINDOW_BEFORE_S = 0.5   # chamber + launch
WINDOW_AFTER_S = 0.4    # impact + retraction
N_SAMPLES = 16
CLUTTER_NEAR_TORSOS = 1.5


def _limb_for(strike_type, subject_id_is_left_lead, strike):
    """(end, mid, root) keypoint indices for the striking limb."""
    is_kick = "kick" in strike_type
    # side recovered from the per-strike debug if present; else infer from type
    side_left = strike.get("debug", {}).get("side_left")
    if side_left is None:
        if is_kick:
            side_left = (strike_type == "lead_kick") == subject_id_is_left_lead
        else:
            side_left = (strike_type == "jab") == subject_id_is_left_lead
    if is_kick:
        return (LEFT_LEG if side_left else RIGHT_LEG), True
    return (LEFT_ARM if side_left else RIGHT_ARM), False


def _resample(values, n):
    """Linear resample a list of (t, value-tuple) to n uniform-time points."""
    if len(values) < 2:
        return [values[0][1]] * n if values else []
    t0, t1 = values[0][0], values[-1][0]
    if t1 <= t0:
        return [values[0][1]] * n
    out = []
    k = 0
    for s in range(n):
        t = t0 + (t1 - t0) * s / (n - 1)
        while k < len(values) - 2 and values[k + 1][0] < t:
            k += 1
        (ta, va), (tb, vb) = values[k], values[k + 1]
        w = (t - ta) / (tb - ta) if tb > ta else 0.0
        out.append(tuple(a + w * (b - a) for a, b in zip(va, vb)))
    return out


def _line_angle(kps, a, b):
    return math.atan2(kps[b]["y"] - kps[a]["y"], kps[b]["x"] - kps[a]["x"])


def extract_strike_features(frames, series, torso, strike, stance):
    """Compute the schema-v1 feature record for one detected strike.

    frames: full clip frames (for clutter — other subjects)
    series: this subject's smoothed series (from _build_series)
    torso:  this subject's median torso length
    """
    t_peak = strike["timestamp_seconds"]
    idx = [k for k, s in enumerate(series)
           if t_peak - WINDOW_BEFORE_S <= s["t"] <= t_peak + WINDOW_AFTER_S]
    if len(idx) < 4 or not torso:
        return {"version": FEATURES_VERSION, "quality": {"frames_used": len(idx), "usable": False}}

    lead_is_left = stance != "southpaw"
    (end, mid_j, root), is_kick = _limb_for(strike["type"], lead_is_left, strike)
    peak_k = min(idx, key=lambda k: abs(series[k]["t"] - t_peak))

    # facing over the window: median sign of nose offset from mid-hip
    offsets = []
    for k in idx:
        kps = series[k]["kps"]
        if kps[0]["visibility"] > MIN_KEYPOINT_CONF:
            offsets.append(kps[0]["x"] - _mid(kps[11], kps[12])["x"])
    facing = 1.0 if (sorted(offsets)[len(offsets) // 2] if offsets else 1.0) >= 0 else -1.0

    def body_frame(kps, j):
        h = _mid(kps[11], kps[12])
        return ((kps[j]["x"] - h["x"]) * facing / torso, (kps[j]["y"] - h["y"]) / torso)

    # paths in body frame (end effector + mid joint), uniform-time resampled
    end_path_t = [(series[k]["t"], body_frame(series[k]["kps"], end)) for k in idx]
    mid_path_t = [(series[k]["t"], body_frame(series[k]["kps"], mid_j)) for k in idx]
    end_path = _resample(end_path_t, N_SAMPLES)
    mid_path = _resample(mid_path_t, N_SAMPLES)

    # speed profile of the end effector (body-frame, torso/s)
    speeds_t = []
    for a, b in zip(end_path_t, end_path_t[1:]):
        dt = b[0] - a[0]
        if dt > 0:
            d = math.hypot(b[1][0] - a[1][0], b[1][1] - a[1][1])
            speeds_t.append(((a[0] + b[0]) / 2, (d / dt,)))
    speed_profile = [round(v[0], 3) for v in _resample(speeds_t, N_SAMPLES)] if speeds_t else []
    peak_speed = max((v for v in speed_profile), default=0.0)
    t_span = end_path_t[-1][0] - end_path_t[0][0]
    time_to_peak = (series[peak_k]["t"] - end_path_t[0][0]) / t_span if t_span > 0 else 0.0

    # Launch segment: from motion onset to peak — NOT the whole window lead-in,
    # which inside combos contains the previous strike. Onset = the last sample
    # before the peak where end-effector speed drops under 30% of peak speed.
    peak_t = series[peak_k]["t"]
    pre_speeds = [(t, v[0]) for t, v in speeds_t if t <= peak_t]
    onset_t = end_path_t[0][0]
    if pre_speeds:
        v_max = max(v for _, v in pre_speeds)
        for t, v in reversed(pre_speeds):
            if v < 0.15 * v_max:
                onset_t = t
                break
        # the arc needs room: never clip the launch under 0.2s
        onset_t = min(onset_t, peak_t - 0.2)
        onset_t = max(onset_t, end_path_t[0][0])
    launch_t = [(t, p) for (t, p) in end_path_t if onset_t <= t <= peak_t]
    # geometry on the resampled (denoised) launch path — raw-sample tangents
    # accumulate keypoint jitter into meaningless turning sums
    launch = _resample(launch_t, 8) if len(launch_t) >= 2 else [p for _, p in launch_t]
    path_len = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(launch, launch[1:]))
    chord = math.hypot(launch[-1][0] - launch[0][0], launch[-1][1] - launch[0][1]) if len(launch) > 1 else 0.0
    straightness = chord / path_len if path_len > 1e-6 else None
    total_turn = 0.0
    segs = [(b[0] - a[0], b[1] - a[1]) for a, b in zip(launch, launch[1:])
            if math.hypot(b[0] - a[0], b[1] - a[1]) > 0.02]
    for (ax, ay), (bx, by) in zip(segs, segs[1:]):
        dot = ax * bx + ay * by
        na, nb = math.hypot(ax, ay), math.hypot(bx, by)
        if na > 0 and nb > 0:
            total_turn += math.degrees(math.acos(max(-1.0, min(1.0, dot / (na * nb)))))
    vertical_frac = (abs(launch[-1][1] - launch[0][1]) / path_len) if path_len > 1e-6 else None

    # acceleration: launch impulse and post-peak deceleration
    accel = []
    for a, b in zip(speeds_t, speeds_t[1:]):
        dt = b[0] - a[0]
        if dt > 0:
            accel.append((a[0], (b[1][0] - a[1][0]) / dt))
    peak_t = series[peak_k]["t"]
    launch_acc = [v for t, v in accel if t <= peak_t]
    decel = [v for t, v in accel if t > peak_t]
    launch_accel = round(sum(launch_acc) / len(launch_acc), 2) if launch_acc else None
    impact_decel = round(min(decel), 2) if decel else None

    # rotation: shoulder/hip line angle deltas (start -> peak) + lag
    def rot_series(a, b):
        out = []
        for k in idx:
            kps = series[k]["kps"]
            if kps[a]["visibility"] > MIN_KEYPOINT_CONF and kps[b]["visibility"] > MIN_KEYPOINT_CONF:
                out.append((series[k]["t"], _line_angle(kps, a, b)))
        return out
    sh, hp = rot_series(5, 6), rot_series(11, 12)

    def rot_delta_and_peak(seq):
        if len(seq) < 3:
            return None, None
        start = seq[0][1]
        peak_val = max(seq, key=lambda x: abs(x[1] - start))
        vel = [((a[0] + b[0]) / 2, abs(b[1] - a[1]) / (b[0] - a[0]))
               for a, b in zip(seq, seq[1:]) if b[0] > a[0]]
        t_max = max(vel, key=lambda x: x[1])[0] if vel else None
        return round(math.degrees(peak_val[1] - start), 1), t_max
    sh_delta, sh_t = rot_delta_and_peak(sh)
    hp_delta, hp_t = rot_delta_and_peak(hp)
    lag_ms = round((sh_t - hp_t) * 1000) if sh_t is not None and hp_t is not None else None

    # context
    peak_kps = series[peak_k]["kps"]
    g_w, g_s = (RIGHT_ARM[0], RIGHT_ARM[2]) if end in (LEFT_ARM[0], LEFT_LEG[0]) else (LEFT_ARM[0], LEFT_ARM[2])
    guard_low = None
    if peak_kps[g_w]["visibility"] > MIN_KEYPOINT_CONF and peak_kps[g_s]["visibility"] > MIN_KEYPOINT_CONF:
        guard_low = bool(peak_kps[g_w]["y"] > peak_kps[g_s]["y"])
    h0 = _mid(series[idx[0]]["kps"][11], series[idx[0]]["kps"][12])
    h1 = _mid(series[idx[-1]]["kps"][11], series[idx[-1]]["kps"][12])
    dt_w = series[idx[-1]]["t"] - series[idx[0]]["t"]
    body_speed = round(_dist(h0, h1) / torso / dt_w, 3) if dt_w > 0 else None

    kick_ctx = {}
    if is_kick:
        other_end = RIGHT_LEG[0] if end == LEFT_LEG[0] else LEFT_LEG[0]
        op = [(series[k]["t"], body_frame(series[k]["kps"], other_end)) for k in idx]
        o_len = sum(math.hypot(b[1][0] - a[1][0], b[1][1] - a[1][1]) for a, b in zip(op, op[1:]))
        kick_ctx = {
            "support_foot_speed": round(o_len / dt_w, 3) if dt_w > 0 else None,
            "chamber": round((peak_kps[mid_j]["y"] - peak_kps[root]["y"]) / torso, 3),
        }

    # clutter: other subjects near, within the window
    sid = strike.get("subject_id")
    min_dist, near = None, 0
    t0, t1 = series[idx[0]]["t"], series[idx[-1]]["t"]
    seen_near = set()
    for frame in frames:
        ft = frame.get("timestamp", 0.0)
        if ft < t0 or ft > t1:
            continue
        own = next((sk["keypoints"] for sk in frame.get("skeletons", []) if sk.get("id") == sid), None)
        if not own or len(own) < 17:
            continue
        own_h = _mid(own[11], own[12])
        for sk in frame.get("skeletons", []):
            if sk.get("id") == sid or len(sk.get("keypoints", [])) < 17:
                continue
            d = _dist(own_h, _mid(sk["keypoints"][11], sk["keypoints"][12])) / torso
            if min_dist is None or d < min_dist:
                min_dist = d
            if d < CLUTTER_NEAR_TORSOS:
                seen_near.add(sk.get("id"))
    near = len(seen_near)

    # left/right wrist swap monitor: consecutive frames where swapping wrists
    # explains the motion better than identity
    lr_swaps = 0
    for ka, kb in zip(idx, idx[1:]):
        a, b = series[ka]["kps"], series[kb]["kps"]
        if any(a[j]["visibility"] <= MIN_KEYPOINT_CONF or b[j]["visibility"] <= MIN_KEYPOINT_CONF for j in (9, 10)):
            continue
        same = _dist(a[9], b[9]) + _dist(a[10], b[10])
        swapped = _dist(a[9], b[10]) + _dist(a[10], b[9])
        if swapped < same * 0.5 and same > 0.2 * torso:
            lr_swaps += 1

    joints = (end, mid_j, root)
    confs = [series[k]["kps"][j]["visibility"] for k in idx for j in joints]
    gaps = [series[kb]["t"] - series[ka]["t"] for ka, kb in zip(idx, idx[1:])]

    return {
        "version": FEATURES_VERSION,
        "path": {
            "end": [(round(x, 3), round(y, 3)) for x, y in end_path],
            "mid": [(round(x, 3), round(y, 3)) for x, y in mid_path],
        },
        "kinematics": {
            "speed_profile": speed_profile,
            "peak_speed": round(peak_speed, 3),
            "time_to_peak_frac": round(time_to_peak, 3),
            "launch_accel": launch_accel,
            "impact_decel": impact_decel,
        },
        "geometry": {
            "straightness": round(straightness, 3) if straightness is not None else None,
            "total_turn_deg": round(total_turn, 1),
            "vertical_frac": round(vertical_frac, 3) if vertical_frac is not None else None,
        },
        "rotation": {
            "shoulder_delta_deg": sh_delta,
            "hip_delta_deg": hp_delta,
            "hip_to_shoulder_lag_ms": lag_ms,
        },
        "context": {
            "guard_other_hand_low": guard_low,
            "body_speed": body_speed,
            **kick_ctx,
            "clutter_min_dist": round(min_dist, 3) if min_dist is not None else None,
            "clutter_subjects_near": near,
            "lr_swap_frames": lr_swaps,
        },
        "quality": {
            "usable": True,
            "frames_used": len(idx),
            "max_gap_ms": round(max(gaps) * 1000) if gaps else None,
            "kp_conf_min": round(min(confs), 3) if confs else None,
            "kp_conf_mean": round(sum(confs) / len(confs), 3) if confs else None,
        },
    }


def annotate_clip_features(frames, all_strikes, subject_stances):
    """Attach strike['features'] to every strike dict, grouped by subject.
    Called from classify_clip — additive only, never affects detection."""
    by_subject: dict = {}
    for s in all_strikes:
        by_subject.setdefault(s.get("subject_id"), []).append(s)
    for sid, strikes in by_subject.items():
        series = _build_series(frames, sid)
        torso = torso_length(series)
        stance = subject_stances.get(sid, "unknown")
        for s in strikes:
            try:
                s["features"] = extract_strike_features(frames, series, torso, s, stance)
            except Exception:
                s["features"] = {"version": FEATURES_VERSION, "quality": {"usable": False, "error": True}}
