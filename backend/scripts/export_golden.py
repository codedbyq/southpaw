"""Export a fully-labeled clip into the golden-set format for golden_eval.py.

Reads the clip's strike detections and strike_labels from the DB, validates
that every detection has a verdict (unlabeled detections are ambiguous ground
truth), derives the true-strike list, and downloads the keypoints JSON from
S3. Writes the <name>.keypoints.json / <name>.labels.json pair golden_eval
expects.

Verdict -> ground truth:
    correct      -> keep detection (timestamp + type)
    wrong_type   -> keep detection with corrected_type
    not_a_strike -> drop
    missed       -> insert at the hand-marked timestamp with corrected_type

Usage:  cd backend && ./venv/bin/python scripts/export_golden.py <clip_id> <golden_dir>
"""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import boto3
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

from models.clip import Clip
from models.job import Job
from models.strike import Strike
from models.strike_label import StrikeLabel


async def export(clip_id: str, golden_dir: Path) -> None:
    eng = create_async_engine(os.environ["DATABASE_URL"])
    Session = async_sessionmaker(eng, expire_on_commit=False)
    async with Session() as db:
        clip = (await db.execute(select(Clip).where(Clip.id == clip_id))).scalar_one_or_none()
        if clip is None:
            sys.exit(f"clip {clip_id} not found")

        job = (await db.execute(
            select(Job).where(Job.clip_id == clip.id, Job.status == "complete")
        )).scalar_one_or_none()
        if job is None or not job.result_s3_key:
            sys.exit("clip has no completed job / keypoints JSON")

        strikes = (await db.execute(
            select(Strike).where(Strike.job_id == job.id).order_by(Strike.timestamp_seconds)
        )).scalars().all()
        label_rows = (await db.execute(
            select(StrikeLabel).where(StrikeLabel.clip_id == clip.id)
            .order_by(StrikeLabel.created_at.asc())
        )).scalars().all()
    await eng.dispose()

    # Latest verdict per strike wins; collect missed marks
    verdicts: dict = {}
    missed = []
    for r in label_rows:
        if r.label == "missed":
            missed.append(r)
        elif r.strike_id is not None:
            verdicts[r.strike_id] = r

    unlabeled = [s for s in strikes if s.id not in verdicts]
    if unlabeled:
        times = ", ".join(f"{s.timestamp_seconds:.1f}s" for s in unlabeled[:8])
        sys.exit(
            f"REFUSING EXPORT: {len(unlabeled)}/{len(strikes)} detections unlabeled "
            f"(first at: {times}{'…' if len(unlabeled) > 8 else ''}). "
            "Label every detection in /label/<clip_id> first."
        )

    # Defensive dedupe: repeated 'm' presses on the same moment create
    # duplicate marks; two identical true strikes would charge the classifier
    # a phantom false negative.
    missed.sort(key=lambda r: r.timestamp_seconds)
    deduped = []
    for r in missed:
        if deduped and r.corrected_type == deduped[-1].corrected_type \
                and r.timestamp_seconds - deduped[-1].timestamp_seconds < 0.3:
            continue
        deduped.append(r)
    dup_count = len(missed) - len(deduped)
    missed = deduped

    true_strikes = []
    for s in strikes:
        v = verdicts[s.id]
        if v.label == "correct":
            true_strikes.append({"timestamp_seconds": s.timestamp_seconds, "type": s.type})
        elif v.label == "wrong_type":
            true_strikes.append({"timestamp_seconds": s.timestamp_seconds, "type": v.corrected_type})
        # not_a_strike -> dropped
    for r in missed:
        true_strikes.append({"timestamp_seconds": r.timestamp_seconds, "type": r.corrected_type})
    true_strikes.sort(key=lambda x: x["timestamp_seconds"])

    # Final pass: a missed-mark stacked on a detection verdict (same type
    # within 0.15s) is one strike, not two — nobody lands two same-type
    # strikes that close (the classifier's own cooldown is 0.2s).
    final = []
    for s in true_strikes:
        if final and s["type"] == final[-1]["type"] \
                and s["timestamp_seconds"] - final[-1]["timestamp_seconds"] < 0.15:
            dup_count += 1
            continue
        final.append(s)
    true_strikes = final

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    obj = s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"], Key=job.result_s3_key)
    keypoints = obj["Body"].read()

    golden_dir.mkdir(parents=True, exist_ok=True)
    name = f"{clip.filename.rsplit('.', 1)[0]}-{str(clip.id)[:8]}"
    (golden_dir / f"{name}.keypoints.json").write_bytes(keypoints)

    labels = {"strikes": true_strikes}
    if clip.selected_subject_id is not None:
        labels["subject_id"] = clip.selected_subject_id
    if clip.stance and clip.stance != "unknown":
        labels["stance"] = clip.stance
    if clip.clip_type:
        labels["clip_type"] = clip.clip_type
    (golden_dir / f"{name}.labels.json").write_text(json.dumps(labels, indent=2))

    dropped = sum(1 for s in strikes if verdicts[s.id].label == "not_a_strike")
    corrected = sum(1 for s in strikes if verdicts[s.id].label == "wrong_type")
    print(
        f"Exported {name}: {len(strikes)} detections -> {len(true_strikes)} true strikes "
        f"({dropped} dropped, {corrected} type-corrected, {len(missed)} missed added"
        + (f", {dup_count} duplicate missed-marks ignored" if dup_count else "") + ")"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    asyncio.run(export(sys.argv[1], Path(sys.argv[2])))
