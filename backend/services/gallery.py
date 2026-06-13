"""Athlete gallery: cross-clip recognition of the consented athlete.

The naive single-signal gallery was measured-and-rejected (scripts/
validate_xclip_{appearance,skeletal}.py): ImageNet appearance picks the wrong
person across clips (clothing/gym dominates), skeletal proportions are correct
but razor-thin. OSNet-AIN ReID embeddings cleared the bar (margin ~0.064 where
ImageNet was -0.033), and crucially *agree* with skeletal — so this fuses both.

What it does NOT do: threshold on absolute distance (same-person cross-clip
variance is high, 0.18-0.25). Production RANKS the subjects in a clip against
the athlete's gallery and picks the nearest, with an honest margin-based
confidence and always-correctable selection (spec D6). The embedding model is
OSNet-AIN MSMT17; embedder lives in services.reid_embedder (GPU); this module
is pure math over precomputed vectors so it unit-tests without a GPU.

Privacy (D2/D3): only the consented athlete's embedding is ever persisted.
This module receives the athlete's gallery and the current clip's per-subject
vectors; it never writes anyone's identity.
"""

EMBEDDING_MODEL = "osnet_ain_x1_0_msmt17"

# Validation (scripts/validate_xclip_gallery.py) measured both fusion and
# nearest-look HURT on the one hard test clip: skeletal pulls a similar-build
# partner closer (margin 0.019 -> 0.002), and nearest-look overfits a
# near-duplicate gallery look (centroid margin 0.064 -> nearest-look 0.019).
# So: centroid appearance is the primary score; skeletal is a tiebreaker only,
# applied when the appearance margin is within SKELETAL_TIEBREAK_BAND. Revisit
# weighting as more labeled multi-person clips land.
SKELETAL_TIEBREAK_BAND = 0.02

# Confidence is margin-based, not absolute-distance-based: how much better the
# best subject matches the gallery than the runner-up, relative to typical
# same-person spread. A lone subject (solo clip) is unambiguous.
MARGIN_FULL_CONFIDENCE = 0.06   # runner-up this much farther => ~certain
MIN_GALLERY_SAMPLES = 1


def _cos_dist(a, b):
    import numpy as np
    if a is None or b is None:
        return None
    a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na == 0 or nb == 0:
        return None
    return 1.0 - float(np.dot(a, b) / (na * nb))


def _prop_dist(a, b):
    if not a or not b:
        return None
    n = min(len(a), len(b))
    return sum(abs(a[i] - b[i]) for i in range(n)) / n


def build_gallery(samples):
    """Aggregate a user's identity samples into a gallery descriptor.
    samples: iterable of objects/dicts with .embedding, .skeletal_stats,
    .confidence, .revoked_at. Returns None if no usable embedding sample."""
    import numpy as np

    def get(s, k):
        return s.get(k) if isinstance(s, dict) else getattr(s, k, None)

    embs, props = [], []
    for s in samples:
        if get(s, "revoked_at") is not None:
            continue
        e = get(s, "embedding")
        if e:
            embs.append(np.asarray(e, dtype=float))
        sk = get(s, "skeletal_stats")
        ratios = _stats_to_vec(sk)
        if ratios:
            props.append(ratios)
    if len(embs) < MIN_GALLERY_SAMPLES:
        return None
    centroid = np.mean(embs, axis=0)
    centroid = centroid / (np.linalg.norm(centroid) or 1.0)
    prop_centroid = list(np.median(np.asarray(props), axis=0)) if props else None
    return {
        "embedding": centroid.tolist(),
        "skeletal": prop_centroid,
        "looks": [e.tolist() for e in embs],   # multi-look set for nearest-look matching
        "n": len(embs),
    }


# limb-ratio keys as produced by services.clip_metrics.skeletal_stats
_RATIO_KEYS = ["upper_arm", "forearm", "upper_leg", "lower_leg", "shoulder_width"]


def _stats_to_vec(skeletal_stats):
    """Order skeletal_stats into a fixed vector; needs every ratio present so
    distances compare like-with-like."""
    if not skeletal_stats:
        return None
    if isinstance(skeletal_stats, list):
        return [float(x) for x in skeletal_stats]
    vec = [skeletal_stats.get(k) for k in _RATIO_KEYS]
    return [float(x) for x in vec] if all(v is not None for v in vec) else None


def rank_subjects(gallery, subjects):
    """Rank a clip's subjects against the gallery (nearest first).

    subjects: {subject_id: {"embedding": [...], "skeletal": [...]}}.
    Returns (ranked, confidence) where ranked is
    [(subject_id, fused_distance, parts), ...] ascending, and confidence is the
    margin-based athlete-anchored score for the top pick (0..1)."""
    if gallery is None or not subjects:
        return [], 0.0

    scored = []
    for sid, feats in subjects.items():
        ad = _cos_dist(gallery["embedding"], feats.get("embedding"))  # centroid distance
        sd = _prop_dist(gallery.get("skeletal"), feats.get("skeletal"))
        if ad is None and sd is None:
            continue
        scored.append((sid, ad if ad is not None else sd,
                       {"appearance": ad, "skeletal": sd}))

    scored.sort(key=lambda x: x[1])
    if not scored:
        return [], 0.0
    if len(scored) == 1:
        return scored, 1.0   # only one candidate — unambiguous within the clip

    # skeletal tiebreaker: only when appearance can't separate the top two
    if scored[1][1] - scored[0][1] < SKELETAL_TIEBREAK_BAND:
        sk = [(s, parts["skeletal"]) for s, _, parts in scored[:2] if parts["skeletal"] is not None]
        if len(sk) == 2 and sk[0][1] != sk[1][1]:
            scored[:2] = sorted(scored[:2], key=lambda x: (x[1], x[2]["skeletal"]))

    margin = scored[1][1] - scored[0][1]
    confidence = max(0.0, min(1.0, margin / MARGIN_FULL_CONFIDENCE))
    return scored, round(confidence, 3)
