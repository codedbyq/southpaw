"""
Pure-Python clip metric helpers shared by the Modal inference pipeline and the
FastAPI subject-reselect endpoint. No cv2 / numpy / modal imports, so it is
safe to import from either context.

All functions operate on the keypoints-JSON `frames` structure:
    frames = [{ "frame", "timestamp", "skeletons": [{"id", "keypoints":[{x,y,visibility}]}],
                "strikes": [{...strike fields incl "subject_id"}] }]
"""

MIN_KEYPOINT_CONF = 0.3


def _pick_skeleton(frame, subject_id):
    """Return the keypoints for `subject_id` in a frame, or the first skeleton
    if subject_id is None (legacy single-subject behaviour)."""
    skeletons = frame.get("skeletons", [])
    if subject_id is None:
        return skeletons[0]["keypoints"] if skeletons else None
    for sk in skeletons:
        if sk.get("id") == subject_id:
            return sk.get("keypoints")
    return None


def compute_head_movement(frames, subject_id=None):
    """Nose-position variance → 0-1 head-movement index for one subject."""
    nose_xs, nose_ys = [], []
    for frame in frames:
        kps = _pick_skeleton(frame, subject_id)
        if kps and kps[0]["visibility"] > MIN_KEYPOINT_CONF:
            nose_xs.append(kps[0]["x"])
            nose_ys.append(kps[0]["y"])
    if len(nose_xs) < 30:
        return None

    def _std(values):
        mean = sum(values) / len(values)
        return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5

    raw_score = (_std(nose_xs) + _std(nose_ys)) / 2
    return min(round(raw_score / 0.15, 3), 1.0)


def detect_stance(frames, subject_id=None):
    """orthodox | southpaw | unknown — which foot leads, judged along the
    fighter's facing direction.

    The old heuristic treated image-left as 'forward', which flipped the
    stance of any fighter facing right in frame (a southpaw facing right was
    called orthodox, inverting every jab/cross and lead/rear kick). Facing is
    inferred per frame from the nose's x-offset off the mid-hip; frames where
    the fighter is squared to camera (offset under a torso-scaled threshold)
    are skipped as ambiguous."""
    left_forward = 0
    right_forward = 0
    for frame in frames:
        kps = _pick_skeleton(frame, subject_id)
        if not kps or len(kps) < 17:
            continue
        nose, ls, rs, lh, rh, la, ra = kps[0], kps[5], kps[6], kps[11], kps[12], kps[15], kps[16]
        if any(k["visibility"] <= MIN_KEYPOINT_CONF for k in (nose, ls, rs, lh, rh, la, ra)):
            continue
        mid_hip_x = (lh["x"] + rh["x"]) / 2
        mid_hip_y = (lh["y"] + rh["y"]) / 2
        mid_sh_x = (ls["x"] + rs["x"]) / 2
        mid_sh_y = (ls["y"] + rs["y"]) / 2
        torso = ((mid_sh_x - mid_hip_x) ** 2 + (mid_sh_y - mid_hip_y) ** 2) ** 0.5
        if torso <= 0:
            continue
        facing = nose["x"] - mid_hip_x
        if abs(facing) < 0.15 * torso:
            continue  # squared to camera — lead foot is ambiguous
        # the lead foot is further along the facing direction
        if (la["x"] - ra["x"]) * facing > 0:
            left_forward += 1
        else:
            right_forward += 1
    total = left_forward + right_forward
    if total < 30:
        return "unknown"
    left_ratio = left_forward / total
    if left_ratio > 0.6:
        return "orthodox"
    elif left_ratio < 0.4:
        return "southpaw"
    return "unknown"


def strikes_for_subject(frames, subject_id):
    """Flatten all strikes belonging to a subject from the per-frame JSON,
    ordered by time. Strikes carry all classifier fields already."""
    out = []
    for frame in frames:
        for strike in frame.get("strikes", []):
            if subject_id is None or strike.get("subject_id") == subject_id:
                out.append(strike)
    out.sort(key=lambda s: s.get("timestamp_seconds", 0))
    return out


def apply_recovery_seconds(strikes):
    """Fill recovery_seconds = gap to this subject's next strike (in place).
    `strikes` should already be a single subject's list, time-ordered."""
    for i, strike in enumerate(strikes):
        if i + 1 < len(strikes):
            strike["recovery_seconds"] = round(
                strikes[i + 1]["timestamp_seconds"] - strike["timestamp_seconds"], 3
            )
        else:
            strike["recovery_seconds"] = None
    return strikes


def _subject_kp_boxes(frames):
    """Per-subject keypoint-derived bbox stats from the frames JSON (the JSON
    stores keypoints, not detector boxes). Returns
    {subject_id: {"frames": n, "heights": [...], "center_dists": [...]}}."""
    stats = {}
    for frame in frames:
        for sk in frame.get("skeletons", []):
            kps = [kp for kp in sk.get("keypoints", []) if kp["visibility"] > MIN_KEYPOINT_CONF]
            if len(kps) < 4:
                continue
            ys = [kp["y"] for kp in kps]
            xs = [kp["x"] for kp in kps]
            cx, cy = sum(xs) / len(xs), sum(ys) / len(ys)
            entry = stats.setdefault(sk.get("id"), {"frames": 0, "heights": [], "center_dists": []})
            entry["frames"] += 1
            entry["heights"].append(max(ys) - min(ys))
            entry["center_dists"].append(((cx - 0.5) ** 2 + (cy - 0.5) ** 2) ** 0.5)
    return stats


def _median(values):
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def score_subjects(frames, strike_counts=None):
    """Composite primary-subject scoring — replaces the summed-bbox-area
    heuristic, which picked whoever was closest to the camera.

    score = presence^1.5 × median_height × (0.5 + 0.5·center_bias) × (1 + log1p(strikes))

    Returns (primary_subject_id, subject_confidence, scores_by_subject).
    subject_confidence = 1 − runner_up_score/top_score; low values mean
    "we weren't sure who the athlete is" and should be surfaced in the UI.
    """
    import math
    strike_counts = strike_counts or {}
    total_frames = len(frames) or 1
    stats = _subject_kp_boxes(frames)
    if not stats:
        return None, None, {}

    scores = {}
    for sid, st in stats.items():
        presence = st["frames"] / total_frames
        height = _median(st["heights"]) or 0.0
        center_bias = 1.0 - min(_median(st["center_dists"]) or 0.7, 0.7) / 0.7
        strikes = strike_counts.get(sid, 0)
        scores[sid] = (
            (presence ** 1.5) * height * (0.5 + 0.5 * center_bias) * (1 + math.log1p(strikes))
        )

    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    primary = ranked[0][0]
    if len(ranked) > 1 and ranked[0][1] > 0:
        confidence = round(1.0 - ranked[1][1] / ranked[0][1], 3)
    else:
        confidence = 1.0
    return primary, confidence, scores


def skeletal_stats(frames, subject_id):
    """Torso-normalized limb-length ratios for a subject — camera-invariant
    identity descriptor stored with identity samples (ReID groundwork)."""
    def dist(a, b):
        return ((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2) ** 0.5

    ratios = {"upper_arm": [], "forearm": [], "upper_leg": [], "lower_leg": [], "shoulder_width": []}
    for frame in frames:
        kps = _pick_skeleton(frame, subject_id)
        if not kps or len(kps) < 17:
            continue
        if not all(kps[i]["visibility"] > MIN_KEYPOINT_CONF for i in (5, 6, 11, 12)):
            continue
        mid_sh = {"x": (kps[5]["x"] + kps[6]["x"]) / 2, "y": (kps[5]["y"] + kps[6]["y"]) / 2}
        mid_hip = {"x": (kps[11]["x"] + kps[12]["x"]) / 2, "y": (kps[11]["y"] + kps[12]["y"]) / 2}
        torso = dist(mid_sh, mid_hip)
        if torso < 0.01:
            continue
        pairs = {
            "upper_arm": [(5, 7), (6, 8)],
            "forearm": [(7, 9), (8, 10)],
            "upper_leg": [(11, 13), (12, 14)],
            "lower_leg": [(13, 15), (14, 16)],
            "shoulder_width": [(5, 6)],
        }
        for name, joints in pairs.items():
            vals = [
                dist(kps[a], kps[b]) / torso
                for a, b in joints
                if kps[a]["visibility"] > MIN_KEYPOINT_CONF and kps[b]["visibility"] > MIN_KEYPOINT_CONF
            ]
            if vals:
                ratios[name].append(sum(vals) / len(vals))

    out = {}
    for name, vals in ratios.items():
        med = _median(vals)
        if med is not None and len(vals) >= 30:
            out[name] = round(med, 4)
    return out or None


def compute_pose_quality(frames, primary_subject_id, mean_luma=None, subject_confidence=None):
    """Per-clip footage quality score (0-1) + components, so the UI can name
    the specific problem ('subject too far from camera') and the LLM payload
    can be confidence-gated. Components per the production-readiness plan:
      brightness, subject_size, kp_confidence, continuity, subject_clarity."""
    total = len(frames) or 1
    stats = _subject_kp_boxes(frames).get(primary_subject_id)

    confs = []
    for frame in frames:
        kps = _pick_skeleton(frame, primary_subject_id)
        if kps:
            confs.extend(kp["visibility"] for kp in kps)

    components = {}
    if mean_luma is not None:
        components["brightness"] = round(min(mean_luma / 110.0, 1.0), 3)
    if stats:
        components["subject_size"] = round(min((_median(stats["heights"]) or 0) / 0.35, 1.0), 3)
        components["continuity"] = round(stats["frames"] / total, 3)
    if confs:
        components["kp_confidence"] = round(sum(confs) / len(confs), 3)
    if subject_confidence is not None:
        components["subject_clarity"] = round(subject_confidence, 3)

    weights = {
        "brightness": 0.15, "subject_size": 0.25, "kp_confidence": 0.25,
        "continuity": 0.20, "subject_clarity": 0.15,
    }
    present = {k: w for k, w in weights.items() if k in components}
    if not present:
        return None, components
    total_w = sum(present.values())
    score = sum(components[k] * w for k, w in present.items()) / total_w
    return round(score, 3), components


def subject_summaries(frames):
    """Per-subject presence + strike counts for the frontend selector.
    Returns [{ "id", "frames", "strikes" }] sorted by presence desc."""
    presence = {}
    strike_counts = {}
    for frame in frames:
        for sk in frame.get("skeletons", []):
            sid = sk.get("id")
            presence[sid] = presence.get(sid, 0) + 1
        for st in frame.get("strikes", []):
            sid = st.get("subject_id")
            if sid is not None:
                strike_counts[sid] = strike_counts.get(sid, 0) + 1
    out = [
        {"id": sid, "frames": n, "strikes": strike_counts.get(sid, 0)}
        for sid, n in presence.items()
    ]
    out.sort(key=lambda s: -s["frames"])
    return out
