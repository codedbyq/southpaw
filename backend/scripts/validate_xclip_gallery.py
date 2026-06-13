"""Exercise services/gallery.py end-to-end on the cross-clip data: build the
athlete gallery from 4 clips, rank subjects on the held-out sparring clip.
Compares OSNet-only vs OSNet+skeletal fusion."""
import asyncio, os, json, sys
import numpy as np
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3, cv2, torch
sys.path.insert(0, '/Users/marquis/Desktop/southpaw/backend')
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from torchreid.reid.utils import FeatureExtractor
from services.clip_metrics import skeletal_stats
from services import gallery as G

GALLERY = [("03147c0b","IMG_0113 bag",1),("3f6bb182","IMG_7678_2 bag",2),
           ("5f4b7e3f","IMG_7678 bag",1),("d6e95407","IMG_9614 pads",1)]
TEST = ("60206ab5","IMG_0113_2 sparring",{2:"USER",1:"partner"})
MIN_CONF=0.3
ex = FeatureExtractor(model_name="osnet_ain_x1_0",
                      model_path="/tmp/reid_weights/osnet_ain_x1_0_msmt17.pt",
                      device="mps" if torch.backends.mps.is_available() else "cpu", verbose=False)

async def info(clip8):
    eng=create_async_engine(os.environ["DATABASE_URL"])
    async with eng.connect() as c:
        r=(await c.execute(text("select c.id::text,c.s3_key,c.filename,j.result_s3_key from clips c "
            "join jobs j on j.clip_id=c.id where c.id::text like :p and j.status='complete' "
            "order by j.started_at desc limit 1"),{"p":clip8+"%"})).fetchone()
    await eng.dispose(); return r

def load(row):
    s3=boto3.client("s3",region_name=os.environ.get("AWS_REGION","us-east-1"))
    cid,s3k,fn,rk=row; v=f"/tmp/xclip/{cid[:8]}-{fn}"
    if not os.path.exists(v): s3.download_file(os.environ["S3_BUCKET_NAME"],s3k,v)
    frames=json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"],Key=rk)["Body"].read())["frames"]
    return v,frames

def osnet_centroid(v,frames,sid,every=0.7):
    boxes={}
    for f in frames:
        for sk in f.get("skeletons",[]):
            if sk.get("id")!=sid: continue
            pts=[(k["x"],k["y"]) for k in sk["keypoints"] if k["visibility"]>MIN_CONF]
            if len(pts)<8: continue
            xs,ys=zip(*pts); boxes[round(f["timestamp"],2)]=(min(xs),min(ys),max(xs),max(ys))
    cap=cv2.VideoCapture(v); fps=cap.get(cv2.CAP_PROP_FPS) or 30; crops=[]; last=-9
    for t in sorted(boxes):
        if t-last<every: continue
        last=t; x0,y0,x1,y1=boxes[t]; cap.set(cv2.CAP_PROP_POS_FRAMES,int(t*fps)); ok,fr=cap.read()
        if not ok: continue
        H,W=fr.shape[:2]; mx,my=0.07*(x1-x0),0.07*(y1-y0)
        a,b=max(0,int((x0-mx)*W)),min(W,int((x1+mx)*W)); c,d=max(0,int((y0-my)*H)),min(H,int((y1+my)*H))
        if b-a<24 or d-c<48: continue
        crops.append(cv2.cvtColor(fr[c:d,a:b],cv2.COLOR_BGR2RGB))
    cap.release()
    if not crops: return None
    fe=ex(crops).cpu().numpy(); fe=fe/np.linalg.norm(fe,axis=1,keepdims=True)
    c=fe.mean(axis=0); return (c/np.linalg.norm(c)).tolist()

async def main():
    samples=[]
    for clip8,label,subj in GALLERY:
        v,frames=load(await info(clip8))
        samples.append({"embedding":osnet_centroid(v,frames,subj),
                        "skeletal_stats":skeletal_stats(frames,subj),
                        "confidence":1.0,"revoked_at":None})
        print(f"gallery sample: {label}")
    gal=G.build_gallery(samples)
    print(f"\ngallery built: n={gal['n']} looks, skeletal={'yes' if gal['skeletal'] else 'no'}")

    v,frames=load(await info(TEST[0]))
    subjects={}
    for sid in TEST[2]:
        e=osnet_centroid(v,frames,sid); s=skeletal_stats(frames,sid)
        subjects[sid]={"embedding":e,"skeletal":G._stats_to_vec(s)}

    ranked,conf=G.rank_subjects(gal,subjects)
    top=ranked[0][0]
    print("\nranked: "+" | ".join(f"subj{s}({TEST[2][s]}) {d:.4f}" for s,d,_ in ranked))
    print(f"  pick: subj{top} ({TEST[2][top]}) — {'CORRECT' if TEST[2][top]=='USER' else 'WRONG'}, confidence {conf}")
asyncio.run(main())
