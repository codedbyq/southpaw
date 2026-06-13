"""Cross-clip identity validation: does the athlete's appearance embedding
transfer across different clips? Gallery = 4 clips where the user is primary;
test = IMG_0113 2 where the user is subject 2 (partner is subject 1)."""
import asyncio, os, json, sys
import numpy as np
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3
sys.path.insert(0, '/Users/marquis/Desktop/southpaw/backend')
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from services.appearance import build_index_from_video, Embedder

# (clip_id8, label, subject_id_that_is_the_user_or_None_for_all)
GALLERY = [("03147c0b", "IMG_0113 bag", 1),
           ("3f6bb182", "IMG_7678_2 bag", 2),
           ("5f4b7e3f", "IMG_7678 bag", 1),
           ("d6e95407", "IMG_9614 pads", 1)]
TEST = ("60206ab5", "IMG_0113_2 sparring", {"user": 2, "partner": 1})

async def fetch(clip8):
    eng = create_async_engine(os.environ["DATABASE_URL"])
    async with eng.connect() as c:
        row = (await c.execute(text(
            "select c.id::text, c.s3_key, c.filename, j.result_s3_key from clips c join jobs j on j.clip_id=c.id "
            "where c.id::text like :p and j.status='complete' order by j.started_at desc limit 1"), {"p": clip8+"%"})).fetchone()
    await eng.dispose()
    return row

def get_video_and_frames(row):
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION","us-east-1"))
    cid, s3_key, fn, result_key = row
    vpath = f"/tmp/xclip/{cid[:8]}-{fn}"
    os.makedirs("/tmp/xclip", exist_ok=True)
    if not os.path.exists(vpath):
        s3.download_file(os.environ["S3_BUCKET_NAME"], s3_key, vpath)
    frames = json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"], Key=result_key)["Body"].read())["frames"]
    return vpath, frames

async def main():
    emb = Embedder()
    cents = {}
    for clip8, label, subj in GALLERY:
        row = await fetch(clip8)
        vpath, frames = get_video_and_frames(row)
        idx = build_index_from_video(vpath, frames, embedder=emb)
        cents[label] = idx.centroid(subj)
        print(f"gallery: {label} (subject {subj}) embedded")
    # gallery centroid = mean of the per-clip user centroids
    gal = np.mean([c for c in cents.values() if c is not None], axis=0)
    gal = gal / np.linalg.norm(gal)

    print("\n--- cross-clip same-person distances (gallery members vs each other) ---")
    labels = list(cents)
    for i in range(len(labels)):
        for j in range(i+1, len(labels)):
            d = 1 - float(np.dot(cents[labels[i]], cents[labels[j]]))
            print(f"  {labels[i]:<22} <-> {labels[j]:<22} {d:.4f}")

    row = await fetch(TEST[0])
    vpath, frames = get_video_and_frames(row)
    idx = build_index_from_video(vpath, frames, embedder=emb)
    print(f"\n--- TEST: {TEST[1]} (user=subj {TEST[2]['user']}, partner=subj {TEST[2]['partner']}) ---")
    du = 1 - float(np.dot(gal, idx.centroid(TEST[2]['user'])))
    dp = 1 - float(np.dot(gal, idx.centroid(TEST[2]['partner'])))
    print(f"  gallery <-> USER subject {TEST[2]['user']}:    {du:.4f}")
    print(f"  gallery <-> PARTNER subject {TEST[2]['partner']}: {dp:.4f}")
    print(f"  => gallery picks subject {TEST[2]['user'] if du < dp else TEST[2]['partner']} "
          f"({'CORRECT (user)' if du < dp else 'WRONG (partner)'}), margin {abs(du-dp):.4f}")

asyncio.run(main())
