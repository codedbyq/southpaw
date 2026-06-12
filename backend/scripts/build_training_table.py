"""Build the (features, label) training table from the golden corpus.

Replays the full pipeline (classify_clip — detection + trajectory feature
annotation) over every golden tier, matches detections to hand labels, and
writes one JSONL row per detection: flattened schema-v1 features + outcome
(tp/fp, predicted type, true type). This is the artifact the rules->ML
transition trains on; it regenerates from keypoints + labels at any time.

Usage:  cd backend && ./venv/bin/python scripts/build_training_table.py [out.jsonl]
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.golden_eval import match, _norm_type
from services.strike_classifier import classify_clip
from services.clip_metrics import detect_stance
from services.strike_features import FEATURES_VERSION

BASE = Path(__file__).resolve().parent.parent
GOLDEN = BASE / "golden"
TIERS = ("core", "holdout")


def _flatten(d, prefix=""):
    out = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(_flatten(v, f"{key}."))
        else:
            out[key] = v
    return out


def main(out_path: Path):
    rows = []
    for tier in TIERS:
        for label_path in sorted((GOLDEN / tier).glob("*.labels.json")):
            name = label_path.name.replace(".labels.json", "")
            kp_path = GOLDEN / tier / f"{name}.keypoints.json"
            if not kp_path.exists():
                continue
            spec = json.loads(label_path.read_text())
            data = json.loads(kp_path.read_text())
            frames = data["frames"]
            sid = spec.get("subject_id", data.get("primary_subject_id"))
            stance = detect_stance(frames, sid)

            all_strikes = classify_clip(frames, {sid: stance}, spec.get("clip_type"))
            preds = [s for s in all_strikes if not s.get("low_confidence")]
            labels = [{**l, "type": _norm_type(l["type"])} for l in spec["strikes"]]
            pairs, _, _ = match(preds, labels)
            truth_by_pred = {id(p): l for p, l in pairs}

            for p in preds:
                l = truth_by_pred.get(id(p))
                feats = p.get("features") or {}
                row = {
                    "clip": name, "tier": tier,
                    "clip_type": spec.get("clip_type"), "stance": stance,
                    "pred_type": p["type"], "confidence": p.get("confidence"),
                    "side_left": p.get("debug", {}).get("side_left"),
                    "tp": l is not None,
                    "true_type": l["type"] if l else None,
                    **{f"f.{k}": v for k, v in _flatten(feats).items()
                       if not k.startswith("path.")},  # paths stay nested
                    "f.path": feats.get("path"),
                }
                rows.append(row)

    with out_path.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    tp = sum(1 for r in rows if r["tp"])
    print(f"{len(rows)} rows ({tp} tp / {len(rows) - tp} fp) -> {out_path} [{FEATURES_VERSION}]")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else BASE / "eval" / "training_table.jsonl"
    main(out)
