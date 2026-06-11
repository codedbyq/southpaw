"""
Golden-set evaluation harness for the strike classifier.

Replays services/strike_classifier.py over recorded keypoints JSONs (no GPU,
no YOLO — pure Python) and scores the detections against hand labels. This is
how classifier thresholds get tuned: change a constant, re-run, compare.

Usage:
    cd backend && python scripts/golden_eval.py path/to/golden_dir

Golden dir layout — one pair of files per clip:
    <name>.keypoints.json   the pipeline output JSON (download from S3:
                            processed/<user>/<clip_id>/keypoints.json)
    <name>.labels.json      hand labels:
        {
          "subject_id": 3,            # optional; default: primary_subject_id from keypoints JSON
          "stance": "orthodox",       # optional; default: detected from keypoints
          "clip_type": "bag",         # optional
          "strikes": [
            {"timestamp_seconds": 12.4, "type": "jab"},
            ...
          ]
        }

A prediction matches a label when |Δt| <= MATCH_TOLERANCE_SECONDS (greedy,
nearest-first). Type accuracy is scored on matched pairs only.
"""

import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.strike_classifier import classify_subject_strikes, MIN_PERSISTED_CONFIDENCE
from services.clip_metrics import detect_stance, score_subjects

MATCH_TOLERANCE_SECONDS = 0.5

# Score on the coarser axis taxonomy: the classifier splits rear-leg kicks into
# roundhouse/rear on a >20° hip-rotation threshold we don't trust yet, while
# hand labels use lead/rear only. Applied to predictions AND labels.
TYPE_ALIASES = {"roundhouse_kick": "rear_kick"}


def _norm_type(t):
    return TYPE_ALIASES.get(t, t)


def _type_match(pred_type, label_type):
    """A generic 'kick' label (axis unclear on video, e.g. switch kicks)
    accepts any kick-family prediction."""
    if label_type == "kick":
        return pred_type == "kick" or pred_type.endswith("_kick")
    return pred_type == label_type


def match(predictions, labels):
    """Greedy nearest-first matching within tolerance.
    Returns list of (pred, label) pairs + unmatched preds + unmatched labels."""
    pairs = []
    used_p, used_l = set(), set()
    candidates = sorted(
        (
            (abs(p["timestamp_seconds"] - l["timestamp_seconds"]), pi, li)
            for pi, p in enumerate(predictions)
            for li, l in enumerate(labels)
            if abs(p["timestamp_seconds"] - l["timestamp_seconds"]) <= MATCH_TOLERANCE_SECONDS
        )
    )
    for _, pi, li in candidates:
        if pi in used_p or li in used_l:
            continue
        used_p.add(pi)
        used_l.add(li)
        pairs.append((predictions[pi], labels[li]))
    unmatched_p = [p for i, p in enumerate(predictions) if i not in used_p]
    unmatched_l = [l for i, l in enumerate(labels) if i not in used_l]
    return pairs, unmatched_p, unmatched_l


def evaluate_case(kp_path: Path, label_path: Path, include_low_confidence: bool):
    data = json.loads(kp_path.read_text())
    spec = json.loads(label_path.read_text())
    frames = data["frames"]

    subject_id = spec.get("subject_id", data.get("primary_subject_id"))
    if subject_id is None:
        subject_id, _, _ = score_subjects(frames)
    stance = spec.get("stance") or detect_stance(frames, subject_id)

    preds = classify_subject_strikes(frames, subject_id, stance, spec.get("clip_type"))
    if not include_low_confidence:
        preds = [p for p in preds if not p.get("low_confidence")]
    for p in preds:
        p["type"] = _norm_type(p["type"])

    labels = [{**l, "type": _norm_type(l["type"])} for l in spec["strikes"]]
    pairs, false_pos, false_neg = match(preds, labels)
    return preds, labels, pairs, false_pos, false_neg


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    golden_dir = Path(sys.argv[1])
    cases = sorted(golden_dir.glob("*.labels.json"))
    if not cases:
        print(f"No *.labels.json files found in {golden_dir}")
        sys.exit(1)

    for include_low in (False, True):
        tag = "ALL strikes (incl. low-confidence)" if include_low else \
              f"persisted strikes (confidence >= {MIN_PERSISTED_CONFIDENCE})"
        print(f"\n{'=' * 70}\n  {tag}\n{'=' * 70}")

        per_class = defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})
        total_tp = total_fp = total_fn = 0
        count_errors = []

        for label_path in cases:
            name = label_path.name.replace(".labels.json", "")
            kp_path = golden_dir / f"{name}.keypoints.json"
            if not kp_path.exists():
                print(f"  ! {name}: missing {kp_path.name}, skipped")
                continue

            preds, labels, pairs, false_pos, false_neg = evaluate_case(
                kp_path, label_path, include_low
            )
            total_tp += len(pairs)
            total_fp += len(false_pos)
            total_fn += len(false_neg)
            count_errors.append(abs(len(preds) - len(labels)))

            type_correct = sum(1 for p, l in pairs if _type_match(p["type"], l["type"]))
            for p, l in pairs:
                if _type_match(p["type"], l["type"]):
                    per_class[l["type"]]["tp"] += 1
                else:
                    per_class[p["type"]]["fp"] += 1
                    per_class[l["type"]]["fn"] += 1
            for p in false_pos:
                per_class[p["type"]]["fp"] += 1
            for l in false_neg:
                per_class[l["type"]]["fn"] += 1

            print(
                f"  {name}: {len(preds)} detected / {len(labels)} labeled · "
                f"matched {len(pairs)} (type-correct {type_correct}) · "
                f"FP {len(false_pos)} · FN {len(false_neg)}"
            )

        def pr(tp, fp, fn):
            p = tp / (tp + fp) if tp + fp else 0.0
            r = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * p * r / (p + r) if p + r else 0.0
            return p, r, f1

        p, r, f1 = pr(total_tp, total_fp, total_fn)
        mae = sum(count_errors) / len(count_errors) if count_errors else 0.0
        print(f"\n  Detection (type-agnostic): precision {p:.2f} · recall {r:.2f} · F1 {f1:.2f}")
        print(f"  Per-clip count MAE: {mae:.1f}")
        print("\n  Per class (type-aware):")
        for cls in sorted(per_class):
            s = per_class[cls]
            p, r, f1 = pr(s["tp"], s["fp"], s["fn"])
            print(f"    {cls:<16} P {p:.2f}  R {r:.2f}  F1 {f1:.2f}   (tp {s['tp']} fp {s['fp']} fn {s['fn']})")


if __name__ == "__main__":
    main()
