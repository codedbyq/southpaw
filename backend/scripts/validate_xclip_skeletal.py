"""Cross-clip identity via SKELETAL proportions (clothing-invariant). Same
gallery/test split as the appearance run. Per-subject = median of per-frame
limb ratios (median kills viewing-angle noise)."""
import asyncio, os, json, sys
import numpy as np
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3
sys.path.insert(0, '/Users/marquis/Desktop/southpaw/backend')
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from services.track_repair import _proportions

GALLERY = [("03147c0b","IMG_0113 bag",1),("3f6bb182","IMG_7678_2 bag",2),
           ("5f4b7e3f","IMG_7678 bag",1),("d6e95407","IMG_9614 pads",1)]
TEST = ("60206ab5","IMG_0113_2 sparring",{"user":2,"partner":1})

async def frames_for(clip8):
    eng = create_async_engine(os.environ["DATABASE_URL"])
    async with eng.connect() as c:
        key = (await c.execute(text("select j.result_s3_key from clips c join jobs j on j.clip_id=c.id "
            "where c.id::text like :p and j.status='complete' order by j.started_at desc limit 1"), {"p":clip8+"%"})).scalar_one()
    await eng.dispose()
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION","us-east-1"))
    return json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"], Key=key)["Body"].read())["frames"]

def subject_proportions(frames, sid):
    props = []
    for f in frames:
        for sk in f.get("skeletons", []):
            if sk.get("id")==sid and len(sk.get("keypoints",[]))>=17:
                p = _proportions(sk["keypoints"])
                if p: props.append(p)
    if not props: return None
    return np.median(np.array(props), axis=0)  # 9-dim limb ratios

def dist(a,b):
    # mean abs ratio difference (same metric as PROPORTION_VETO)
    return float(np.mean(np.abs(a-b)))

async def main():
    cents = {}
    for clip8,label,subj in GALLERY:
        cents[label] = subject_proportions(await frames_for(clip8), subj)
        print(f"gallery: {label} (subject {subj}) proportions computed")
    gal = np.median([c for c in cents.values() if c is not None], axis=0)
    print("\n--- cross-clip same-person proportion distances ---")
    labels = list(cents)
    for i in range(len(labels)):
        for j in range(i+1,len(labels)):
            print(f"  {labels[i]:<22} <-> {labels[j]:<22} {dist(cents[labels[i]],cents[labels[j]]):.4f}")
    frames = await frames_for(TEST[0])
    pu = subject_proportions(frames, TEST[2]['user'])
    pp = subject_proportions(frames, TEST[2]['partner'])
    du, dp = dist(gal,pu), dist(gal,pp)
    print(f"\n--- TEST: {TEST[1]} ---")
    print(f"  gallery <-> USER subj {TEST[2]['user']}:    {du:.4f}")
    print(f"  gallery <-> PARTNER subj {TEST[2]['partner']}: {dp:.4f}")
    print(f"  => picks subject {TEST[2]['user'] if du<dp else TEST[2]['partner']} "
          f"({'CORRECT (user)' if du<dp else 'WRONG (partner)'}), margin {abs(du-dp):.4f}")
asyncio.run(main())
