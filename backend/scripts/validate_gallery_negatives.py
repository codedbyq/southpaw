"""Expanded gallery validation with user-confirmed labels:
- positives: clips the user is in (leave-one-out)
- negatives: IMG_6336, IMG_1335 (confirmed NOT the user)
- mirror diagnostic on IMG_7678 (possible front-camera flip)
Question: does the held-out USER rank closer to the gallery than NON-users?"""
import asyncio, os, json, sys
import numpy as np
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3, cv2, torch
sys.path.insert(0,'/Users/marquis/Desktop/southpaw/backend')
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from torchreid.reid.utils import FeatureExtractor

USER = [("03147c0b","IMG_0113",1),("3f6bb182","IMG_7678_2",2),
        ("5f4b7e3f","IMG_7678(mirror?)",1),("d6e95407","IMG_9614",1)]
NEG  = [("2ef841d9","IMG_6336",None),("63c5c943","IMG_1335",None)]  # None=top meaningful subj
MIN_CONF=0.3
ex=FeatureExtractor(model_name="osnet_ain_x1_0",model_path="/tmp/reid_weights/osnet_ain_x1_0_msmt17.pt",
                    device="mps" if torch.backends.mps.is_available() else "cpu",verbose=False)

_META={}
async def resolve_all(c8s):
    eng=create_async_engine(os.environ["DATABASE_URL"])
    async with eng.connect() as c:
        for c8 in c8s:
            r=(await c.execute(text("select c.id::text,c.s3_key,c.filename,j.result_s3_key from clips c join jobs j on j.clip_id=c.id "
                "where c.id::text like :p and j.status='complete' order by j.started_at desc limit 1"),{"p":c8+"%"})).fetchone()
            _META[c8]=r
    await eng.dispose()
def info(c8): return _META[c8]

def load(row):
    s3=boto3.client("s3",region_name=os.environ.get("AWS_REGION","us-east-1"))
    cid,s3k,fn,rk=row; v=f"/tmp/xclip/{cid[:8]}-{fn.replace('/','_')}"
    if not os.path.exists(v): s3.download_file(os.environ["S3_BUCKET_NAME"],s3k,v)
    frames=json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"],Key=rk)["Body"].read())["frames"]
    return v,frames

def top_subject(frames):
    cnt={}
    for f in frames:
        for sk in f.get("skeletons",[]): cnt[sk["id"]]=cnt.get(sk["id"],0)+1
    return max(cnt,key=cnt.get) if cnt else None

def centroid(v,frames,sid,flip=False,every=0.7):
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
        crop=fr[c:d,a:b]
        if flip: crop=cv2.flip(crop,1)
        crops.append(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB))
    cap.release()
    if not crops: return None
    fe=ex(crops).cpu().numpy(); fe=fe/np.linalg.norm(fe,axis=1,keepdims=True)
    c=fe.mean(axis=0); return c/np.linalg.norm(c)

def d(a,b): return 1-float(np.dot(a,b))

async def main():
    await resolve_all([x[0] for x in USER+NEG])
    U={}
    for c8,lbl,sid in USER:
        v,fr=load(info(c8)); U[lbl]=centroid(v,fr,sid); print(f"user: {lbl}")
    N={}
    for c8,lbl,_ in NEG:
        v,fr=load(info(c8)); s=top_subject(fr); N[lbl]=centroid(v,fr,s); print(f"neg:  {lbl} (subj {s})")

    print("\n=== LEAVE-ONE-OUT: held-out user vs negatives ===")
    for held in U:
        gal=np.mean([U[k] for k in U if k!=held],axis=0); gal/=np.linalg.norm(gal)
        du=d(gal,U[held])
        dn={lbl:d(gal,N[lbl]) for lbl in N}
        worst_neg=min(dn.values())
        ok="OK" if du<worst_neg else "FAIL"
        print(f"  held {held:<18} user {du:.3f} | "+" ".join(f"{k} {v:.3f}" for k,v in dn.items())+f"  [{ok}]")

    print("\n=== MIRROR diagnostic: IMG_7678 normal vs h-flipped, dist to other-user centroid ===")
    others=np.mean([U[k] for k in U if not k.startswith("IMG_7678(")],axis=0); others/=np.linalg.norm(others)
    v,fr=load(info("5f4b7e3f")); 
    n=centroid(v,fr,1,flip=False); fl=centroid(v,fr,1,flip=True)
    print(f"  IMG_7678 normal -> other-user centroid: {d(others,n):.3f}")
    print(f"  IMG_7678 flipped-> other-user centroid: {d(others,fl):.3f}")
asyncio.run(main())
