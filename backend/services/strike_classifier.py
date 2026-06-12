"""
Rules-based strike classifier v2 — pure Python, no cv2/numpy/modal imports.

Replaces the per-frame velocity-threshold classifier that lived in
modal_inference.py. Key differences:

- Time-based: windows/cooldowns are in seconds, so 30fps and 60fps clips of the
  same punch produce the same strikes (the old VELOCITY_WINDOW=5 frames missed
  most strikes on 60fps phone video).
- Body-normalized: velocities and distances are in torso-lengths (mid-shoulder
  to mid-hip), so detection and arm_extension don't depend on camera distance.
- Stance-aware: jab = lead-hand straight, cross = rear-hand straight. Both
  wrists are evaluated every frame (the old code checked the right wrist first
  and mapped right→jab, which inverted jab/cross for orthodox fighters).
- Retraction check: a strike requires extension rise + fall, which kills the
  walking/reset/face-wipe false positives.
- Per-strike confidence (0-1), finally populating strikes.confidence. Strikes
  below MIN_PERSISTED_CONFIDENCE stay in the keypoints JSON (flagged
  low_confidence) but are excluded from Postgres metrics and LLM payloads.

Runs as a post-pass over the keypoints-JSON `frames` structure, which means the
golden-set harness can replay it on recorded JSONs without a GPU, and the
select-subject endpoint sees identical results.

COCO keypoints: 0 nose, 5/6 shoulders, 7/8 elbows, 9/10 wrists,
11/12 hips, 13/14 knees, 15/16 ankles.
"""

import math

# Version stamp for this rules implementation. Bump on any behavioral change;
# combined with the YOLO model name into clips.pipeline_version.
# rules-3: facing-aware stance detection (clip_metrics.detect_stance) — fixes
# inverted jab/cross + lead/rear kick naming for fighters facing right.
# rules-4: punch stride veto (wrist-to-body velocity ratio), persistence
# confidence floor 0.4 -> 0.6.
# rules-5: hooks named by axis (lead_hook/rear_hook) from striking side + stance.
# rules-6: uppercut candidate class — vertical wrist rises admitted, gated on
# close-range bent-arm geometry; previously structurally undetectable.
RULES_VERSION = "rules-6"

MIN_KEYPOINT_CONF = 0.3
SMOOTHING_ALPHA = 0.5            # EMA over keypoint positions before kinematics

WINDOW_SECONDS = 0.17            # velocity measurement window (~5 frames @ 30fps)
MAX_GAP_SECONDS = 0.40           # tracking gap larger than this breaks the window
SAME_LIMB_COOLDOWN_SECONDS = 0.5
SUBJECT_COOLDOWN_SECONDS = 0.20  # allows fast jab-cross combos across hands

PUNCH_VELOCITY_THRESHOLD = 3.5   # torso-lengths / second
KICK_VELOCITY_THRESHOLD = 3.0
SHADOW_THRESHOLD_FACTOR = 0.8    # shadowboxing has no impact deceleration

# Kick false-positive gates, measured at the velocity peak. Tuned on the
# 10-clip golden corpus (footwork — pivots, advances, skip-steps — fired the
# kick rule 4x more often than real kicks): real kicks chamber the knee and
# move much faster than stride noise, and the support foot stays planted.
KICK_MIN_PEAK_VELOCITY = 4.0       # true-kick median 8.1; footwork FP median 4.9
KICK_CHAMBER_MAX_BELOW_HIP = 0.8   # knee height vs hip in torso-lengths; FP median 0.79
KICK_SUPPORT_FOOT_MAX_V = 2.5      # both feet fast = skip/switch-step, not a kick

# Punch false-positive gate: a real punch moves the wrist much faster than the
# body; an arm swinging along with a stride doesn't (corpus: true-punch
# wrist-to-body ratio median 6.7, phantom median 4.0).
PUNCH_MIN_WRIST_TO_BODY_RATIO = 2.0

# Uppercut gates. Vertical-dominant wrist rise was structurally excluded by
# the |dx|>|dy| punch condition, making uppercuts undetectable. Vertical
# candidates are now admitted but must pass ALL gates at the peak — upward
# wrist motion is mostly guard resets and face wipes, so the gates encode what
# only an uppercut does: a fast bent-arm rise finishing at head height, close
# to the body. Candidates admitted only for vertical motion that fail these
# gates are discarded, never renamed into other punches.
UPPERCUT_MAX_LATERAL_OFFSET = 0.45        # |wrist.x − shoulder.x| at peak, torso units
UPPERCUT_MIN_EXTENSION = 0.30             # below this the wrist is hugging the shoulder —
                                          # a guard adjustment, not a punch (corpus FPs
                                          # clustered at 0.05-0.25; the true hit at 0.36)
UPPERCUT_MAX_EXTENSION = 0.85             # uppercuts land bent, never extended
UPPERCUT_WRIST_MAX_BELOW_SHOULDER = 0.15  # wrist finishes at/above the shoulder line

RETRACTION_WINDOW_SECONDS = 0.6  # extension must fall after its peak within this
RETRACTION_DROP_RATIO = 0.10     # ...by at least 10% of peak extension
EXTENSION_PEAK_SEARCH_SECONDS = 0.3

MIN_PERSISTED_CONFIDENCE = 0.6   # below this: JSON-only, flagged low_confidence
                                 # (0.4 -> 0.6 measured on the golden corpus: kills ~4 FPs
                                 # per sacrificed TP)
MIN_PRESENCE_SECONDS = 2.0       # don't classify subjects barely on screen

# limb keypoint indices: (end_effector, mid_joint, root_joint)
LEFT_ARM = (9, 7, 5)
RIGHT_ARM = (10, 8, 6)
LEFT_LEG = (15, 13, 11)
RIGHT_LEG = (16, 14, 12)


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _mid(a, b):
    return {"x": (a["x"] + b["x"]) / 2, "y": (a["y"] + b["y"]) / 2}


def _build_series(frames, subject_id):
    """Extract this subject's (frame_index, timestamp, keypoints) samples and
    EMA-smooth the positions. Raw visibilities are preserved (confidence is a
    measurement, smoothing it would hide dropouts)."""
    series = []
    smoothed_prev = None
    for frame in frames:
        kps = None
        for sk in frame.get("skeletons", []):
            if sk.get("id") == subject_id:
                kps = sk.get("keypoints")
                break
        if not kps or len(kps) < 17:
            continue
        if smoothed_prev is None:
            smoothed = [dict(kp) for kp in kps]
        else:
            smoothed = []
            for i, kp in enumerate(kps):
                prev = smoothed_prev[i]
                if kp["visibility"] >= MIN_KEYPOINT_CONF:
                    smoothed.append({
                        "x": SMOOTHING_ALPHA * kp["x"] + (1 - SMOOTHING_ALPHA) * prev["x"],
                        "y": SMOOTHING_ALPHA * kp["y"] + (1 - SMOOTHING_ALPHA) * prev["y"],
                        "visibility": kp["visibility"],
                    })
                else:
                    # Don't let a dropout drag the position toward garbage —
                    # hold the last good position, keep the (low) confidence.
                    smoothed.append({"x": prev["x"], "y": prev["y"], "visibility": kp["visibility"]})
        smoothed_prev = smoothed
        series.append({
            "frame": frame.get("frame"),
            "t": frame.get("timestamp", 0.0),
            "kps": smoothed,
        })
    return series


def _median(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def torso_length(series):
    """Median mid-shoulder→mid-hip distance (normalized image units)."""
    lengths = []
    for sample in series:
        kps = sample["kps"]
        if all(kps[i]["visibility"] >= MIN_KEYPOINT_CONF for i in (5, 6, 11, 12)):
            lengths.append(_dist(_mid(kps[5], kps[6]), _mid(kps[11], kps[12])))
    return _median(lengths)


def _window_start(series, i):
    """Index j such that series[i].t - series[j].t ≈ WINDOW_SECONDS, or None if
    the track has a gap bigger than MAX_GAP_SECONDS inside the window."""
    t_i = series[i]["t"]
    j = i
    while j > 0 and t_i - series[j - 1]["t"] <= WINDOW_SECONDS:
        j -= 1
    if j == i:
        return None  # no history yet
    if t_i - series[j]["t"] > MAX_GAP_SECONDS + WINDOW_SECONDS:
        return None
    # require reasonably dense samples (no mid-window dropout)
    for k in range(j, i):
        if series[k + 1]["t"] - series[k]["t"] > MAX_GAP_SECONDS:
            return None
    return j


def _limb_velocity(series, i, j, idx, torso):
    """Velocity of keypoint idx between samples j→i in torso-lengths/sec."""
    cur, past = series[i]["kps"][idx], series[j]["kps"][idx]
    dt = series[i]["t"] - series[j]["t"]
    if dt <= 0:
        return 0.0, 0.0, 0.0
    d = _dist(cur, past) / torso / dt
    dx = (cur["x"] - past["x"]) / torso / dt
    dy = (cur["y"] - past["y"]) / torso / dt
    return d, dx, dy


def _mean_conf(series, j, i, joints):
    vals = [series[k]["kps"][idx]["visibility"] for k in range(j, i + 1) for idx in joints]
    return sum(vals) / len(vals) if vals else 0.0


def _angle(kps, a, b):
    return math.degrees(math.atan2(kps[b]["y"] - kps[a]["y"], kps[b]["x"] - kps[a]["x"]))


def _hip_rotation(series, j, i):
    cur, past = series[i]["kps"], series[j]["kps"]
    needed = (5, 6, 11, 12)
    if not all(cur[k]["visibility"] > MIN_KEYPOINT_CONF and past[k]["visibility"] > MIN_KEYPOINT_CONF
               for k in needed):
        return None
    return round(abs((_angle(cur, 5, 6) - _angle(past, 5, 6)) -
                     (_angle(cur, 11, 12) - _angle(past, 11, 12))), 2)


def _extension_curve(series, center_i, root_idx, end_idx, torso):
    """(time, extension) samples around center_i for the retraction check."""
    t0 = series[center_i]["t"]
    out = []
    for k in range(max(0, center_i - 20), min(len(series), center_i + 40)):
        dt = series[k]["t"] - t0
        if dt < -EXTENSION_PEAK_SEARCH_SECONDS:
            continue
        if dt > RETRACTION_WINDOW_SECONDS + EXTENSION_PEAK_SEARCH_SECONDS:
            break
        kps = series[k]["kps"]
        out.append((dt, _dist(kps[end_idx], kps[root_idx]) / torso))
    return out


def _retraction(curve):
    """Returns (pattern_complete, peak_extension). Extension must peak near the
    velocity peak and then fall by RETRACTION_DROP_RATIO within the window."""
    if len(curve) < 3:
        return False, None
    pre = [e for dt, e in curve if dt <= EXTENSION_PEAK_SEARCH_SECONDS]
    if not pre:
        return False, None
    peak = max(pre)
    after = [e for dt, e in curve if dt > 0]
    if not after:
        return False, peak
    dropped = min(after) <= peak * (1 - RETRACTION_DROP_RATIO)
    return dropped, peak


def classify_subject_strikes(frames, subject_id, stance="unknown", clip_type=None):
    """Detect strikes for one tracked subject. Returns time-ordered strike
    dicts; entries below MIN_PERSISTED_CONFIDENCE carry low_confidence=True."""
    series = _build_series(frames, subject_id)
    if len(series) < 5 or (series[-1]["t"] - series[0]["t"]) < MIN_PRESENCE_SECONDS:
        return []
    torso = torso_length(series)
    if not torso or torso <= 0.01:
        return []

    punch_thresh = PUNCH_VELOCITY_THRESHOLD
    kick_thresh = KICK_VELOCITY_THRESHOLD
    if clip_type == "shadow":
        punch_thresh *= SHADOW_THRESHOLD_FACTOR
        kick_thresh *= SHADOW_THRESHOLD_FACTOR

    stance_known = stance in ("orthodox", "southpaw")
    # orthodox: left side leads; southpaw: right side leads. Unknown defaults
    # to orthodox (most common) with a confidence penalty.
    lead_is_left = stance != "southpaw"

    strikes = []
    last_by_limb = {}
    last_any = -1e9

    i = 0
    while i < len(series):
        j = _window_start(series, i)
        if j is None:
            i += 1
            continue
        t = series[i]["t"]
        kps = series[i]["kps"]

        candidates = []  # (velocity, limb_key, kind, side_is_left, dx, dy)
        for limb_key, (end, mid, root), is_left in (
            ("lw", LEFT_ARM, True), ("rw", RIGHT_ARM, False),
        ):
            if kps[end]["visibility"] < MIN_KEYPOINT_CONF:
                continue
            v, dx, dy = _limb_velocity(series, i, j, end, torso)
            horizontal = abs(dx) > abs(dy)
            vertical_rise = dy < 0 and abs(dy) >= abs(dx)
            if v > punch_thresh and (horizontal or vertical_rise):
                # vert_only: admitted solely as an uppercut candidate — must
                # pass the uppercut gates or be discarded entirely
                candidates.append((v, limb_key, "punch", is_left, (end, mid, root), not horizontal))
        for limb_key, (end, mid, root), is_left in (
            ("la", LEFT_LEG, True), ("ra", RIGHT_LEG, False),
        ):
            if kps[end]["visibility"] < MIN_KEYPOINT_CONF:
                continue
            v, dx, dy = _limb_velocity(series, i, j, end, torso)
            knee_v, _, _ = _limb_velocity(series, i, j, mid, torso)
            # a kick lifts the ankle (dy<0 in image coords) and drives the knee
            if v > kick_thresh and dy < 0 and knee_v > 0.4 * v:
                candidates.append((v, limb_key, "kick", is_left, (end, mid, root), False))

        if not candidates:
            i += 1
            continue

        v, limb_key, kind, is_left, (end, mid, root), vert_only = max(candidates)
        if t - last_by_limb.get(limb_key, -1e9) < SAME_LIMB_COOLDOWN_SECONDS or \
           t - last_any < SUBJECT_COOLDOWN_SECONDS:
            i += 1
            continue

        # Ride the velocity peak forward so metrics are measured at impact.
        peak_i, peak_v = i, v
        k = i + 1
        while k < len(series) and series[k]["t"] - t < WINDOW_SECONDS:
            jk = _window_start(series, k)
            if jk is None:
                break
            vk, _, _ = _limb_velocity(series, k, jk, end, torso)
            if vk > peak_v:
                peak_i, peak_v = k, vk
            k += 1
        peak = series[peak_i]
        peak_kps = peak["kps"]

        # Kick FP gates (see constants above): vetoed candidates advance one
        # frame without consuming cooldowns, so a real strike right after a
        # vetoed stride is still detectable.
        if kind == "kick":
            chamber = (peak_kps[mid]["y"] - peak_kps[root]["y"]) / torso
            other_end = RIGHT_LEG[0] if end == LEFT_LEG[0] else LEFT_LEG[0]
            jp = _window_start(series, peak_i)
            v_other = _limb_velocity(series, peak_i, jp, other_end, torso)[0] if jp is not None else 0.0
            if peak_v < KICK_MIN_PEAK_VELOCITY \
                    or chamber > KICK_CHAMBER_MAX_BELOW_HIP \
                    or v_other > KICK_SUPPORT_FOOT_MAX_V:
                i += 1
                continue
        else:
            jp = _window_start(series, peak_i)
            if jp is not None:
                dtp = peak["t"] - series[jp]["t"]
                if dtp > 0:
                    cur_h = _mid(peak_kps[11], peak_kps[12])
                    past_h = _mid(series[jp]["kps"][11], series[jp]["kps"][12])
                    v_body = _dist(cur_h, past_h) / torso / dtp
                    if peak_v < PUNCH_MIN_WRIST_TO_BODY_RATIO * v_body:
                        i += 1
                        continue

        # Retraction / extension pattern
        curve = _extension_curve(series, peak_i, root, end, torso)
        pattern_complete, peak_ext = _retraction(curve)

        # --- type naming ---
        if kind == "punch":
            elbow = peak_kps[mid]
            wrist = peak_kps[end]
            shoulder = peak_kps[root]

            # Uppercut check first: vertical-dominant at the peak + all gates.
            jp2 = _window_start(series, peak_i)
            dx_pk = dy_pk = 0.0
            if jp2 is not None:
                _, dx_pk, dy_pk = _limb_velocity(series, peak_i, jp2, end, torso)
            uppercut_shape = (
                dy_pk < 0 and abs(dy_pk) >= abs(dx_pk)
                and shoulder["visibility"] > MIN_KEYPOINT_CONF
                and abs(wrist["x"] - shoulder["x"]) < UPPERCUT_MAX_LATERAL_OFFSET * torso
                and UPPERCUT_MIN_EXTENSION < _dist(shoulder, wrist) / torso < UPPERCUT_MAX_EXTENSION
                and wrist["y"] - shoulder["y"] < UPPERCUT_WRIST_MAX_BELOW_SHOULDER * torso
            )
            if uppercut_shape:
                strike_type = "lead_uppercut" if (is_left == lead_is_left) else "rear_uppercut"
            elif vert_only:
                # admitted only for vertical motion and failed the uppercut
                # gates — a guard reset or face wipe, not a strike
                i += 1
                continue
            else:
                # Lateral compactness at peak. Measured alternatives on the golden
                # corpus (tighter 0.30; AND extension < 0.85) traded hook recall
                # for straight precision at no net gain — kept as-is.
                hook_shape = (
                    elbow["visibility"] > MIN_KEYPOINT_CONF
                    and abs(wrist["x"] - elbow["x"]) < 0.35 * torso
                )
                if hook_shape:
                    strike_type = "lead_hook" if (is_left == lead_is_left) else "rear_hook"
                else:
                    strike_type = "jab" if (is_left == lead_is_left) else "cross"
        else:
            hip_rot = _hip_rotation(series, _window_start(series, peak_i) or peak_i, peak_i)
            is_rear_leg = (is_left != lead_is_left)
            if is_rear_leg:
                strike_type = "roundhouse_kick" if (hip_rot or 0) > 20 else "rear_kick"
            else:
                strike_type = "lead_kick"

        # --- per-strike metrics ---
        arm_extension = None
        if kind == "punch" and peak_kps[root]["visibility"] > MIN_KEYPOINT_CONF \
                and peak_kps[end]["visibility"] > MIN_KEYPOINT_CONF:
            arm_extension = round(_dist(peak_kps[root], peak_kps[end]) / torso, 4)

        # guard_dropped: non-striking wrist below its own shoulder line.
        # (The old nose-line check flagged a correct chin-level guard.)
        guard_dropped = None
        if kind == "punch":
            g_wrist, g_shoulder = (RIGHT_ARM[0], RIGHT_ARM[2]) if is_left else (LEFT_ARM[0], LEFT_ARM[2])
            if peak_kps[g_wrist]["visibility"] > MIN_KEYPOINT_CONF and \
               peak_kps[g_shoulder]["visibility"] > MIN_KEYPOINT_CONF:
                guard_dropped = bool(peak_kps[g_wrist]["y"] > peak_kps[g_shoulder]["y"])
        else:
            checks = []
            for w, s in ((9, 5), (10, 6)):
                if peak_kps[w]["visibility"] > MIN_KEYPOINT_CONF and \
                   peak_kps[s]["visibility"] > MIN_KEYPOINT_CONF:
                    checks.append(peak_kps[w]["y"] > peak_kps[s]["y"])
            guard_dropped = bool(any(checks)) if checks else None

        hip_rotation = _hip_rotation(series, j, peak_i)

        # --- confidence ---
        thresh = punch_thresh if kind == "punch" else kick_thresh
        velocity_margin = max(0.0, min(1.0, (peak_v - thresh) / thresh))
        joints = (end, mid, root)
        kp_conf = _mean_conf(series, j, peak_i, joints)
        pattern_score = 1.0 if pattern_complete else 0.3
        confidence = 0.35 * velocity_margin + 0.35 * kp_conf + 0.30 * pattern_score
        if not stance_known and kind == "punch":
            confidence -= 0.1  # jab/cross and lead/rear hook axis all depend on stance
        confidence = round(max(0.0, min(1.0, confidence)), 3)

        strike = {
            "type": strike_type,
            "timestamp_seconds": round(peak["t"], 4),
            "frame_index": peak["frame"],
            "subject_id": subject_id,
            "confidence": confidence,
            "low_confidence": confidence < MIN_PERSISTED_CONFIDENCE,
            "arm_extension": arm_extension,
            "guard_dropped": guard_dropped,
            "peak_velocity": round(peak_v, 4),
            "hip_rotation": hip_rotation,
            "debug": {
                "velocity": round(peak_v, 3),
                "threshold": round(thresh, 3),
                "window_ms": int(WINDOW_SECONDS * 1000),
                "kp_conf": round(kp_conf, 3),
                "pattern_complete": pattern_complete,
                "peak_extension": round(peak_ext, 3) if peak_ext is not None else None,
                "torso_length": round(torso, 4),
                "stance_known": stance_known,
                "side_left": is_left,
            },
        }
        strikes.append(strike)
        last_by_limb[limb_key] = peak["t"]
        last_any = peak["t"]
        # jump past the peak so we don't re-trigger on the same motion
        i = peak_i + 1

    return strikes


def classify_clip(frames, subject_stances, clip_type=None):
    """Classify every subject in a clip and embed strikes back into the
    per-frame JSON structure (frames[n]["strikes"]).

    subject_stances: {subject_id: "orthodox"|"southpaw"|"unknown"}
    Returns the flat list of all strikes across subjects, time-ordered.
    """
    for frame in frames:
        frame["strikes"] = []
    frame_by_index = {f.get("frame"): f for f in frames}

    all_strikes = []
    for subject_id, stance in subject_stances.items():
        for strike in classify_subject_strikes(frames, subject_id, stance, clip_type):
            all_strikes.append(strike)
            target = frame_by_index.get(strike["frame_index"])
            if target is not None:
                target["strikes"].append(strike)

    all_strikes.sort(key=lambda s: s["timestamp_seconds"])

    # Trajectory features (schema v1) — additive annotation, stored with every
    # detection so future labels become training rows retroactively. Imported
    # here (not module top) to keep strike_features' import of this module
    # cycle-free.
    from services.strike_features import annotate_clip_features
    annotate_clip_features(frames, all_strikes, subject_stances)

    return all_strikes
