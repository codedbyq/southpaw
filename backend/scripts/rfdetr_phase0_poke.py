"""Phase 0 proof of life: load RFDETRKeypointPreview, run on one frame from
the baseline clip, dump the keypoints output shape so we can plan the
JSON-schema/normalization adapter."""
import warnings, os, sys
warnings.filterwarnings("ignore")
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
sys.path.insert(0, '/Users/marquis/Desktop/southpaw/backend')
import cv2, numpy as np, time
from rfdetr import RFDETRKeypointPreview

CLIP = "/tmp/track_exp/03147c0b-IMG_0113.MOV"  # cached locally from earlier work
if not os.path.exists(CLIP):
    sys.exit(f"need cached video at {CLIP}")

cap = cv2.VideoCapture(CLIP)
ok, frame = cap.read()
H, W = frame.shape[:2]
cap.release()
rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
print(f"frame: {W}x{H}")

t0 = time.time()
m = RFDETRKeypointPreview()
print(f"model loaded in {time.time()-t0:.1f}s | size={getattr(m,'size','?')}")

t0 = time.time()
kp = m.predict(rgb, threshold=0.3)
print(f"first inference: {time.time()-t0:.2f}s")

# warm second pass
t0 = time.time()
kp = m.predict(rgb, threshold=0.3)
print(f"warm inference:  {time.time()-t0:.2f}s\n")

print("output type:", type(kp).__name__)
print("attrs:", [a for a in dir(kp) if not a.startswith('_')])
print("len:", len(kp) if hasattr(kp,'__len__') else '?')
print()
# poke key fields
for name in ("xy","confidence","class_id","data"):
    v = getattr(kp, name, None)
    if v is None: continue
    if hasattr(v,'shape'): print(f"  {name}.shape: {v.shape}, dtype {v.dtype}")
    elif isinstance(v, dict): print(f"  {name} keys: {list(v.keys())}")
    else: print(f"  {name}: {type(v).__name__}, sample {str(v)[:80]}")

# uncertainty details
cov = kp.data.get('covariance')
chol = kp.data.get('keypoint_precision_cholesky')
print(f"\ncovariance.shape: {cov.shape if cov is not None else '?'}")
print(f"cholesky.shape:   {chol.shape if chol is not None else '?'}")
print(f"detection confidences: {kp.confidence.mean(axis=1)}")  # per-person mean kp-conf
print(f"detection_confidence: {getattr(kp,'detection_confidence',None)}")
print(f"class_id: {kp.class_id}")
print(f"first person xy[0:3]: {kp.xy[0,:3]}")
# resolution actually fed in
import rfdetr
print(f"\nmodel resolution attr: {getattr(m, 'resolution', '?')}")
print(f"model size attr: {m.size}")
