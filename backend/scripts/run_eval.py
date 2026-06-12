"""Tiered golden-set evaluation with manifest assertions and ratchet baselines.

Runs the classifier replay (via golden_eval machinery) over golden/core and
golden/holdout separately, slices metrics by class and clip type, checks the
assertions in eval/manifest.json, and (optionally) writes a metrics-only
report to eval/reports/. Exits non-zero if any baseline or fixture assertion
fails — wire this into pre-merge checks.

Usage:
    cd backend && ./venv/bin/python scripts/run_eval.py            # run + assert
    cd backend && ./venv/bin/python scripts/run_eval.py --report   # also write report JSON

Tiers (see eval/manifest.json):
    golden/core      tuned-against, headline metrics + ratchet baselines
    golden/holdout   never tuned against; report-only generalization check
    golden/regression/tracking   quarantined tracking failures; presence-checked only
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.golden_eval import evaluate_case, _type_match
from services.strike_classifier import RULES_VERSION

BASE = Path(__file__).resolve().parent.parent
GOLDEN = BASE / "golden"
MANIFEST_PATH = BASE / "eval" / "manifest.json"


def _pr(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return round(p, 3), round(r, 3), round(f1, 3)


def eval_tier(tier_dir: Path) -> dict | None:
    cases = sorted(tier_dir.glob("*.labels.json"))
    if not cases:
        return None
    tier = {"clips": {}, "per_class": defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0}),
            "per_clip_type": defaultdict(lambda: {"tp": 0, "fp": 0, "fn": 0})}
    tp = fp = fn = matched = type_ok = 0
    count_err = []

    for label_path in cases:
        name = label_path.name.replace(".labels.json", "")
        kp_path = tier_dir / f"{name}.keypoints.json"
        if not kp_path.exists():
            print(f"  ! {name}: missing keypoints, skipped")
            continue
        clip_type = json.loads(label_path.read_text()).get("clip_type") or "unknown"
        preds, labels, pairs, fpos, fneg = evaluate_case(kp_path, label_path, include_low_confidence=False)

        c_type_ok = sum(1 for p, l in pairs if _type_match(p["type"], l["type"]))
        tier["clips"][name] = {
            "detected": len(preds), "labeled": len(labels), "matched": len(pairs),
            "type_correct": c_type_ok, "fp": len(fpos), "fn": len(fneg),
            "clip_type": clip_type,
        }
        tp += len(pairs); fp += len(fpos); fn += len(fneg)
        matched += len(pairs); type_ok += c_type_ok
        count_err.append(abs(len(preds) - len(labels)))

        for p, l in pairs:
            key = l["type"] if _type_match(p["type"], l["type"]) else None
            if key:
                tier["per_class"][key]["tp"] += 1
            else:
                tier["per_class"][p["type"]]["fp"] += 1
                tier["per_class"][l["type"]]["fn"] += 1
        for p in fpos:
            tier["per_class"][p["type"]]["fp"] += 1
        for l in fneg:
            tier["per_class"][l["type"]]["fn"] += 1
        ct = tier["per_clip_type"][clip_type]
        ct["tp"] += len(pairs); ct["fp"] += len(fpos); ct["fn"] += len(fneg)

    p, r, f1 = _pr(tp, fp, fn)
    tier["summary"] = {
        "clips": len(tier["clips"]), "true_strikes": tp + fn,
        "precision": p, "recall": r, "f1": f1,
        "type_accuracy": round(type_ok / matched, 3) if matched else None,
        "count_mae": round(sum(count_err) / len(count_err), 1) if count_err else None,
    }
    tier["per_class"] = {
        k: dict(v, **dict(zip(("precision", "recall", "f1"), _pr(v["tp"], v["fp"], v["fn"]))))
        for k, v in sorted(tier["per_class"].items())
    }
    tier["per_clip_type"] = {
        k: dict(v, **dict(zip(("precision", "recall", "f1"), _pr(v["tp"], v["fp"], v["fn"]))))
        for k, v in sorted(tier["per_clip_type"].items())
    }
    return tier


def check_assertions(manifest: dict, tiers: dict) -> list[str]:
    failures = []
    base = manifest.get("baselines", {})
    for tier_name, floors in base.items():
        summary = (tiers.get(tier_name) or {}).get("summary")
        if summary is None:
            failures.append(f"baseline tier '{tier_name}' has no clips")
            continue
        for key, floor in floors.items():
            metric = key.removesuffix("_min")
            val = summary.get(metric)
            if val is None or val < floor:
                failures.append(f"baseline {tier_name}.{metric} = {val} < floor {floor}")

    for fx in manifest.get("fixtures", []):
        checks = fx.get("assert", {})
        if checks.get("quarantined"):
            tier_dir = GOLDEN / fx["tier"]
            if not any(fx["name"] in p.name for p in tier_dir.glob("*.json")):
                failures.append(f"fixture {fx['name']}: missing from {fx['tier']} (quarantine broken)")
            continue
        clip = (tiers.get(fx["tier"]) or {}).get("clips", {}).get(fx["name"])
        if clip is None:
            failures.append(f"fixture {fx['name']}: not found in tier {fx['tier']}")
            continue
        if "fp_max" in checks and clip["fp"] > checks["fp_max"]:
            failures.append(f"fixture {fx['name']}: fp {clip['fp']} > {checks['fp_max']}")
        if "fn_max" in checks and clip["fn"] > checks["fn_max"]:
            failures.append(f"fixture {fx['name']}: fn {clip['fn']} > {checks['fn_max']}")
        if "type_accuracy_min" in checks:
            acc = clip["type_correct"] / clip["matched"] if clip["matched"] else 0.0
            if acc < checks["type_accuracy_min"]:
                failures.append(f"fixture {fx['name']}: type accuracy {acc:.2f} < {checks['type_accuracy_min']}")
    return failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report", action="store_true", help="write metrics report to eval/reports/")
    args = ap.parse_args()

    manifest = json.loads(MANIFEST_PATH.read_text())
    tiers = {}
    for tier_name in ("core", "holdout"):
        result = eval_tier(GOLDEN / tier_name)
        if result is not None:
            tiers[tier_name] = result

    for tier_name, t in tiers.items():
        s = t["summary"]
        print(f"\n[{tier_name}] {s['clips']} clips · {s['true_strikes']} true strikes")
        print(f"  precision {s['precision']} · recall {s['recall']} · f1 {s['f1']} · "
              f"type-acc {s['type_accuracy']} · count MAE {s['count_mae']}")
        for ct, v in t["per_clip_type"].items():
            print(f"    {ct:<10} P {v['precision']:.2f} R {v['recall']:.2f} F1 {v['f1']:.2f}")
    if "holdout" not in tiers:
        print("\n[holdout] empty — next labeled clips land here (export to golden/holdout/)")

    failures = check_assertions(manifest, tiers)
    print()
    if failures:
        print("ASSERTION FAILURES:")
        for f in failures:
            print(f"  ✗ {f}")
    else:
        print("all baselines and fixture assertions pass ✓")

    if args.report:
        out = {
            "date": date.today().isoformat(),
            "rules_version": RULES_VERSION,
            "tiers": {k: {kk: vv for kk, vv in v.items()} for k, v in tiers.items()},
            "assertion_failures": failures,
        }
        path = BASE / "eval" / "reports" / f"{date.today().isoformat()}-{RULES_VERSION}.json"
        path.write_text(json.dumps(out, indent=2, default=dict))
        print(f"report written: {path.relative_to(BASE)}")

    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
