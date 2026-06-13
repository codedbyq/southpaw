"""Cross-clip identity via OSNet-AIN (purpose-trained, domain-robust person
ReID). Same gallery/test split as the ImageNet probe — only the embedder
changes. Reuses cached videos in /tmp/xclip and production keypoints JSONs."""
import asyncio, os, json, sys
import numpy as np
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3, cv2, torch
sys.path.insert(0, '/Users/marquis/Desktop/southpaw/backend')
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from torchreid.reid.utils import FeatureExtractor

GALLERY = [("03147c0b","IMG_0113 bag",1),("3f6bb182","IMG_7678_2 bag",2),
           ("5f4b7e3f","IMG_7678 bag",1),("d6e95407","IMG_9614 pads",1)]
TEST = ("60206ab5","IMG_0113_2 sparring",{"user":2,"partner":1})
MIN_CONF = 0.3
device = "mps" if torch.backends.mps.is_available() else "cpu"
ex = FeatureExtractor(model_name="osnet_ain_x1_0", model_path="/tmp/reid_weights/osnet_ain_x1_0_msmt17.pt", device=device, verbose=False)

async def info(clip8):
    eng = create_async_engine(os.environ["DATABASE_URL"])
    async with eng.connect() as c:
        row = (await c.execute(text("select c.id::text,c.s3_key,c.filename,j.result_s3_key from clips c "
            "join jobs j on j.clip_id=c.id where c.id::text like :p and j.status='complete' "
            "order by j.started_at desc limit 1"),{"p":clip8+"%"})).fetchone()
    await eng.dispose(); return row

def subj_centroid(row, sid, every=0.7):
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION","us-east-1"))
    cid,s3key,fn,rkey = row
    vpath=f"/tmp/xclip/{cid[:8]}-{fn}"
    if not os.path.exists(vpath):
        os.makedirs("/tmp/xclip",exist_ok=True); s3.download_file(os.environ["S3_BUCKET_NAME"],s3key,vpath)
    frames=json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"],Key=rkey)["Body"].read())["frames"]
    boxes={}
    for f in frames:
        for sk in f.get("skeletons",[]):
            if sk.get("id")!=sid: continue
            pts=[(k["x"],k["y"]) for k in sk["keypoints"] if k["visibility"]>MIN_CONF]
            if len(pts)<8: continue
            xs,ys=zip(*pts); boxes[round(f["timestamp"],2)]=(min(xs),min(ys),max(xs),max(ys))
    cap=cv2.VideoCapture(vpath); fps=cap.get(cv2.CAP_PROP_FPS) or 30
    crops=[]; last=-9
    for t in sorted(boxes):
        if t-last<every: continue
        last=t; x0,y0,x1,y1=boxes[t]
        cap.set(cv2.CAP_PROP_POS_FRAMES,int(t*fps)); ok,fr=cap.read()
        if not ok: continue
        H,W=fr.shape[:2]; mx,my=0.07*(x1-x0),0.07*(y1-y0)
        a,b=max(0,int((x0-mx)*W)),min(W,int((x1+mx)*W)); c,d=max(0,int((y0-my)*H)),min(H,int((y1+my)*H))
        if b-a<24 or d-c<48: continue
        crops.append(cv2.cvtColor(fr[c:d,a:b],cv2.COLOR_BGR2RGB))
    cap.release()
    if not crops: return None
    feats=ex(crops).cpu().numpy()
    feats=feats/np.linalg.norm(feats,axis=1,keepdims=True)
    cnt=feats.mean(axis=0); return cnt/np.linalg.norm(cnt)

async def main():
    cents={}
    for clip8,label,subj in GALLERY:
        cents[label]=subj_centroid(await info(clip8),subj); print(f"gallery: {label} embedded (OSNet)")
    gal=np.mean([c for c in cents.values() if c is not None],axis=0); gal=gal/np.linalg.norm(gal)
    print("\n--- cross-clip same-person (OSNet) ---")
    L=list(cents)
    for i in range(len(L)):
        for j in range(i+1,len(L)):
            print(f"  {L[i]:<22} <-> {L[j]:<22} {1-float(np.dot(cents[L[i]],cents[L[j]])):.4f}")
    row=await info(TEST[0])
    du=1-float(np.dot(gal,subj_centroid(row,TEST[2]['user'])))
    dp=1-float(np.dot(gal,subj_centroid(row,TEST[2]['partner'])))
    print(f"\n--- TEST: {TEST[1]} ---")
    print(f"  gallery <-> USER subj {TEST[2]['user']}:    {du:.4f}")
    print(f"  gallery <-> PARTNER subj {TEST[2]['partner']}: {dp:.4f}")
    print(f"  => picks subject {TEST[2]['user'] if du<dp else TEST[2]['partner']} "
          f"({'CORRECT (user)' if du<dp else 'WRONG (partner)'}), margin {abs(du-dp):.4f}")
asyncio.run(main())
