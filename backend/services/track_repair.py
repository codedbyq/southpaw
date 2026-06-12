"""Track repair — stage 1: stitching fragmented tracklets.

ByteTrack drops and re-issues ids during occlusion and clutter (measured:
114.6 tracklets/min on the fragmentation fixture, 85 ids on a busy-gym core
clip), shattering a subject's history. This pure-Python post-pass merges
tracklets that are physically the same person: B continues A if B starts
about where A's motion predicts, at a compatible body size, within a short
gap — and never if their lifespans genuinely overlap (two people seen
simultaneously are never the same person).

Pure function over the keypoints-JSON `frames` structure — replayable
offline on stored clips, same pattern as the strike classifier. Canonical
id for a merged chain = the member with the most frames (most stable
reference for labels/selections). The returned report carries the full
raw→canonical mapping for auditability and label remapping.

Versioned: bump REPAIR_VERSION on any behavioral change.
"""

from services.strike_classifier import MIN_KEYPOINT_CONF, _dist, _mid

REPAIR_VERSION = "repair-2"  # stitch-1 + appearance adjudication + drift splits

STITCH_MAX_GAP_S = 2.0        # bridge id gaps up to this long
STITCH_OVERLAP_TOL_S = 0.3    # tracker handoffs briefly double-track one person
STITCH_BASE_JUMP_TORSOS = 1.0 # allowed position error at zero gap...
STITCH_JUMP_PER_S = 1.5       # ...growing with gap (people move while unseen)
SIZE_RATIO_RANGE = (0.75, 1.33)
PROPORTION_VETO = 0.30        # mean abs limb-ratio diff above this = different people
BOUNDARY_WINDOW_S = 0.34      # window for boundary position/velocity estimates


def _proportions(kps):
    """Conf-gated limb ratios (torso-normalized) for one skeleton, or None."""
    pairs = [(5, 7), (7, 9), (6, 8), (8, 10), (11, 13), (13, 15), (12, 14), (14, 16), (5, 6)]
    if any(kps[i]["visibility"] <= MIN_KEYPOINT_CONF for p in pairs for i in p) or \
       any(kps[i]["visibility"] <= MIN_KEYPOINT_CONF for i in (11, 12)):
        return None
    torso = _dist(_mid(kps[5], kps[6]), _mid(kps[11], kps[12]))
    if torso <= 1e-6:
        return None
    return [_dist(kps[a], kps[b]) / torso for a, b in pairs]


def _tracklets(frames):
    """Per-subject summaries: time span, boundary positions/velocities, size,
    median limb proportions."""
    raw = {}
    for f in frames:
        t = f.get("timestamp", 0.0)
        for sk in f.get("skeletons", []):
            kps = sk.get("keypoints", [])
            if len(kps) < 17:
                continue
            lh, rh = kps[11], kps[12]
            if lh["visibility"] <= MIN_KEYPOINT_CONF or rh["visibility"] <= MIN_KEYPOINT_CONF:
                continue
            entry = raw.setdefault(sk["id"], {"samples": [], "props": []})
            hip = _mid(lh, rh)
            torso = None
            if kps[5]["visibility"] > MIN_KEYPOINT_CONF and kps[6]["visibility"] > MIN_KEYPOINT_CONF:
                torso = _dist(_mid(kps[5], kps[6]), hip)
            entry["samples"].append((t, hip["x"], hip["y"], torso))
            p = _proportions(kps)
            if p:
                entry["props"].append(p)

    def _median(vals):
        s = sorted(vals)
        return s[len(s) // 2] if s else None

    out = {}
    for sid, e in raw.items():
        s = e["samples"]
        if not s:
            continue
        torsos = [x[3] for x in s if x[3]]
        torso = _median(torsos)
        if not torso:
            continue

        def boundary(samples, head):
            ref_t = samples[0][0] if head else samples[-1][0]
            win = [x for x in samples if abs(x[0] - ref_t) <= BOUNDARY_WINDOW_S]
            x0, y0 = win[0][1], win[0][2]
            x1, y1 = win[-1][1], win[-1][2]
            dt = win[-1][0] - win[0][0]
            vx, vy = ((x1 - x0) / dt, (y1 - y0) / dt) if dt > 0 else (0.0, 0.0)
            pos = (x0, y0) if head else (x1, y1)
            return pos, (vx, vy)

        start_pos, start_vel = boundary(s, head=True)
        end_pos, end_vel = boundary(s, head=False)
        props = None
        if e["props"]:
            n = len(e["props"][0])
            props = [_median([p[i] for p in e["props"]]) for i in range(n)]
        out[sid] = {
            "t0": s[0][0], "t1": s[-1][0], "n": len(s),
            "start_pos": start_pos, "end_pos": end_pos, "end_vel": end_vel,
            "torso": torso, "props": props,
        }
    return out


def _prop_dist(a, b):
    if not a or not b:
        return None
    return sum(abs(x - y) for x, y in zip(a, b)) / len(a)


def plan_stitches(frames, appearance=None, strict=False):
    """Returns (id_map, report). id_map maps every raw id to its canonical id
    (identity for unmerged tracklets).

    appearance: optional services.appearance.AppearanceIndex. Geometric merge
    candidates are rejected when the two tracklets' boundary-segment
    embeddings differ beyond STITCH_MAX_DISTANCE (measured failure without
    this: the stitcher re-merged a fighter onto the pad holder across a
    crossover). strict=True additionally rejects candidates appearance cannot
    verify (no crops on one side) — the production setting."""
    tk = _tracklets(frames)
    pairs = []
    for a, A in tk.items():
        for b, B in tk.items():
            if a == b:
                continue
            gap = B["t0"] - A["t1"]
            if gap < -STITCH_OVERLAP_TOL_S or gap > STITCH_MAX_GAP_S:
                continue
            scale = (A["torso"] + B["torso"]) / 2
            ratio = A["torso"] / B["torso"]
            if not (SIZE_RATIO_RANGE[0] <= ratio <= SIZE_RATIO_RANGE[1]):
                continue
            g = max(gap, 0.0)
            pred = (A["end_pos"][0] + A["end_vel"][0] * g,
                    A["end_pos"][1] + A["end_vel"][1] * g)
            err = ((pred[0] - B["start_pos"][0]) ** 2 + (pred[1] - B["start_pos"][1]) ** 2) ** 0.5 / scale
            allowance = STITCH_BASE_JUMP_TORSOS + STITCH_JUMP_PER_S * g
            if err > allowance:
                continue
            pd = _prop_dist(A["props"], B["props"])
            if pd is not None and pd > PROPORTION_VETO:
                continue
            if appearance is not None:
                from services.appearance import distance, STITCH_MAX_DISTANCE, BUCKET_SECONDS
                tail = appearance.centroid(a, A["t1"] - 2 * BUCKET_SECONDS, A["t1"] + 0.5)
                head = appearance.centroid(b, B["t0"] - 0.5, B["t0"] + 2 * BUCKET_SECONDS)
                ad = distance(tail, head)
                if ad is not None and ad > STITCH_MAX_DISTANCE:
                    continue
                if ad is None and strict:
                    continue
            score = err / allowance + (pd if pd is not None else 0.15)
            pairs.append((score, a, b))

    pairs.sort()
    succ, pred = {}, {}
    parent = {sid: sid for sid in tk}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def chain_spans(root):
        return [(tk[s]["t0"], tk[s]["t1"]) for s in tk if find(s) == root]

    merges = []
    for score, a, b in pairs:
        if a in succ or b in pred:
            continue
        ra, rb = find(a), find(b)
        if ra == rb:
            continue
        # the merged chain must stay temporally coherent — no member of one
        # side may overlap a member of the other beyond the handoff tolerance
        ok = True
        for (s0, s1) in chain_spans(ra):
            for (u0, u1) in chain_spans(rb):
                if min(s1, u1) - max(s0, u0) > STITCH_OVERLAP_TOL_S:
                    ok = False
                    break
            if not ok:
                break
        if not ok:
            continue
        succ[a] = b
        pred[b] = a
        parent[rb] = ra
        merges.append((a, b, round(score, 3)))

    id_map = {}
    by_root = {}
    for sid in tk:
        by_root.setdefault(find(sid), []).append(sid)
    for root, members in by_root.items():
        canonical = max(members, key=lambda s: tk[s]["n"])
        for m in members:
            id_map[m] = canonical

    report = {
        "version": REPAIR_VERSION,
        "tracklets_before": len(tk),
        "tracklets_after": len(by_root),
        "merges": merges,
        "id_map": {str(k): v for k, v in id_map.items() if k != v},
    }
    return id_map, report


def _apply_id_map(frames, id_map):
    for f in frames:
        for sk in f.get("skeletons", []):
            sk["id"] = id_map.get(sk["id"], sk["id"])
        for s in f.get("strikes", []) or []:
            if s.get("subject_id") is not None:
                s["subject_id"] = id_map.get(s["subject_id"], s["subject_id"])


def apply_splits(frames, splits):
    """Cut tracks at appearance changepoints: a track with splits at
    [t1, t2, ...] becomes segments [start,t1), [t1,t2), ... — the first keeps
    the original id, later segments get fresh ids. Returns
    ({(orig_id, segment_index): new_id}, resolver) where resolver(sid, t)
    maps an original id at time t to its post-split id."""
    if not splits:
        return {}, lambda sid, t: sid
    next_id = max((sk["id"] for f in frames for sk in f.get("skeletons", [])), default=0) + 1
    sorted_splits = {sid: sorted(ts) for sid, ts in splits.items() if ts}
    assigned = {}

    def resolve(sid, t):
        nonlocal next_id
        ts = sorted_splits.get(sid)
        if not ts:
            return sid
        seg = sum(1 for x in ts if t >= x)
        if seg == 0:
            return sid
        key = (sid, seg)
        if key not in assigned:
            assigned[key] = next_id
            next_id += 1
        return assigned[key]

    for f in frames:
        t = f.get("timestamp", 0.0)
        for sk in f.get("skeletons", []):
            sk["id"] = resolve(sk["id"], t)
        for s in f.get("strikes", []) or []:
            if s.get("subject_id") is not None:
                s["subject_id"] = resolve(s["subject_id"], t)
    return assigned, resolve


def apply_repair(frames, appearance=None, strict=False):
    """Plan and apply repair in place: drift splits first (when appearance is
    available), then adjudicated stitching. Returns the report."""
    split_report = {}
    if appearance is not None:
        from services.appearance import find_drift_splits
        splits = find_drift_splits(appearance)
        if splits:
            assigned, resolve = apply_splits(frames, splits)
            split_report = {f"{old}#seg{seg}": new for (old, seg), new in assigned.items()}
            # the index must follow the split, or the stitcher sees the new
            # tail as unverifiable and may re-merge the split we just made
            appearance = appearance.remap(resolve)

    id_map, report = plan_stitches(frames, appearance=appearance, strict=strict)
    if report["merges"]:
        _apply_id_map(frames, id_map)
    report["splits"] = split_report
    report["version"] = REPAIR_VERSION
    return report
