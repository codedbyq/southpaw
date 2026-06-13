"""Prove the production code path: reid_embedder.embed_subjects + gallery
build/rank, on the real test clip (user=subj2, partner=subj1)."""
import asyncio, os, json, sys
from dotenv import load_dotenv
load_dotenv('/Users/marquis/Desktop/southpaw/backend/.env')
import boto3
sys.path.insert(0,'/Users/marquis/Desktop/southpaw/backend')
# force the embedder to use the S3 weights path it will use in prod
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text
from services.reid_embedder import embed_subjects, EMBEDDING_MODEL
from services.gallery import build_gallery, rank_subjects, _stats_to_vec
from services.clip_metrics import skeletal_stats

GAL=[("03147c0b",1),("3f6bb182",2),("5f4b7e3f",1),("d6e95407",1)]
TEST=("60206ab5",{2:"USER",1:"partner"})

async def meta(c8s):
    eng=create_async_engine(os.environ["DATABASE_URL"]); out={}
    async with eng.connect() as c:
        for c8 in c8s:
            out[c8]=(await c.execute(text("select c.id::text,c.s3_key,c.filename,j.result_s3_key from clips c join jobs j on j.clip_id=c.id where c.id::text like :p and j.status='complete' order by j.started_at desc limit 1"),{"p":c8+"%"})).fetchone()
    await eng.dispose(); return out

def load(row):
    s3=boto3.client("s3",region_name=os.environ.get("AWS_REGION","us-east-1"))
    cid,s3k,fn,rk=row; v=f"/tmp/xclip/{cid[:8]}-{fn.replace('/','_')}"
    if not os.path.exists(v): s3.download_file(os.environ["S3_BUCKET_NAME"],s3k,v)
    fr=json.loads(s3.get_object(Bucket=os.environ["S3_BUCKET_NAME"],Key=rk)["Body"].read())["frames"]
    return v,fr

async def main():
    M=await meta([c for c,_ in GAL]+[TEST[0]])
    samples=[]
    for c8,sid in GAL:
        v,fr=load(M[c8])
        emb=embed_subjects(v,fr,[sid]).get(sid)
        samples.append({"embedding":emb,"skeletal_stats":skeletal_stats(fr,sid),"confidence":1.0,"revoked_at":None})
    gal=build_gallery(samples)
    print(f"gallery built from {gal['n']} samples, model {EMBEDDING_MODEL}")
    v,fr=load(M[TEST[0]])
    embs=embed_subjects(v,fr,list(TEST[1]))
    subjects={sid:{"embedding":e,"skeletal":_stats_to_vec(skeletal_stats(fr,sid))} for sid,e in embs.items()}
    ranked,conf=rank_subjects(gal,subjects)
    top=ranked[0][0]
    print("ranked:", " | ".join(f"subj{s}({TEST[1][s]}) {d:.4f}" for s,d,_ in ranked))
    print(f"pick subj{top} ({TEST[1][top]}) — {'CORRECT' if TEST[1][top]=='USER' else 'WRONG'}, conf {conf}")
    print(f"would override heuristic (conf>=0.4): {conf>=0.4}")
asyncio.run(main())
