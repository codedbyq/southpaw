# Evaluating RF-DETR keypoints as a YOLO11-pose replacement

> **Status:** Phase 0 complete · 2026-06-13
> **Why:** AGPL-3.0 → Apache 2.0 license fix, +14 COCO AP headline gain, per-joint
> uncertainty ellipses (new signal we don't have), better tracking through occlusion (claimed).
> **Strategy:** parallel pipelines behind the existing keypoints-JSON seam — no replacement
> until measured wins on the golden corpus + ratchet + cost budget.

---

## Phase 0 — Proof of life (DONE)

Local sanity-check on MPS before committing to a real swap. One frame from
the baseline clip (`IMG_0113` first frame, 2160×3840), via `scripts/rfdetr_phase0_poke.py`.

### Verdict: **GO to Phase 1** with caveats noted below.

### What we learned

**Schema compatibility — clean fit:**
- `xy.shape = (N, 17, 2)` — **COCO-17, our exact downstream contract.** No
  keypoint remap needed; classifier limb indices (5/6 shoulders, 7/8 elbows,
  9/10 wrists, 11/12 hips, 13/14 knees, 15/16 ankles) apply unchanged.
- `confidence.shape = (N, 17)` — per-joint scalar confidence, drop-in for our
  existing `visibility` field.
- The current `yolo11s-pose.pt` outputs the same skeleton, so swapping behind
  our `_build_series` adapter is a few lines, not a port.

**Uncertainty signal — confirmed present and rich:**
- `data["covariance"].shape = (N, 17, 2, 2)` — full 2D covariance matrix per
  joint, exactly as Skalski's post claimed.
- `data["keypoint_precision_cholesky"]` also exposed (`(N, 17, 3)`).
- Concretely lets us revisit the impossible-extension gate we had to abandon:
  if true-strike wrist excursions are small-covariance and bag-impact garbage
  is large-covariance, the gate becomes usable again. Phase 2 hypothesis.

**Detection on IMG_0113 frame 1:**
- Found 4 person-candidates (gym, multi-person background, expected).
- Per-person mean keypoint confidence: 0.74-0.91 — looks well-calibrated.
- Per-person `detection_confidence` (a separate aggregate): 0.32-3.85 — note
  this scale is non-obvious; needs documentation review before we use it for
  filtering.

### Caveats to carry into Phase 1

1. **Weight-loading warnings on init** (worth understanding before trusting metrics):
   - `Pretrained weights ... loaded only partially — 4 checkpoint key(s) not consumed`
     (the `keypoint_head.keypoint_proj.*` weights).
   - `Checkpoint has 1 classes but model is configured for 90.`
   - `Using patch size 12 instead of 14` and "different number of positional encodings" notices.
   These are likely benign (it loads useful weights and runs), but they
   leave room for "the model is silently degraded vs the published 71.8 AP."
   Action: verify our local detections on a few well-known images look right
   before reading too much into golden-corpus numbers, and re-check after
   `model.optimize_for_inference()`.

2. **Model variant is large.** Class loaded is
   `rfdetr-keypoint-preview-xlarge.pth`, 156MB. YOLO11s is ~22MB. The
   tweet's "9.7ms on T4" likely refers to a specific variant — confirm
   which one before extrapolating cost. The `RFDETRKeypointPreview` class
   apparently maps to xlarge; if smaller variants exist (`RFDETRNano`,
   `RFDETRSmall`, etc. exist for detection — keypoints variants TBD), Phase 1
   should test the size that matches our latency budget, not just the biggest.

3. **MPS warm inference at full 4K: 0.33s/frame.** Useful only as a sanity
   anchor — real cost answer comes from T4 in Modal, with our downscale to
   720p short side and stride-2 for 60fps clips. Phase 1 measures end-to-end
   wall-clock-per-clip, the only number that matters.

4. **Supervision version conflict.** Installing `rfdetr` pulled
   `supervision==0.29.0.post0`. Our local pin was `supervision<0.30` because
   `sv.ByteTrack` was removed in 0.30+. Production Modal image still pins
   `<0.30`, so this is venv-local only — but Phase 1 needs a clean separate
   Modal image that installs both rfdetr and a way to track (either keep
   `<0.30` and use rfdetr's own outputs only, switch to Ultralytics-native
   tracking per spec D11, or use a separate tracker).

5. **Cold start cost.** First call after model load: 9.5s (model+first
   inference). Warm: 0.33s. T4 will be different; budget for ~1 cold-start
   penalty per Modal function invocation.

### Kill criteria not triggered
- COCO-17 compatibility: ✅
- Schema readable: ✅
- Inference runs without error: ✅
- Uncertainty exposed: ✅ (bonus)

→ **Proceed to Phase 1**.

---

## Phases 1–4 (planned, not yet started)

### Phase 1 — Golden head-to-head

Reprocess `golden/core/` (9 clips) through RF-DETR; emit parallel keypoint
JSONs alongside the YOLO11 ones. Replay the unchanged classifier through
`make eval` for each. Record per-clip wall-clock.

**Deliverables:**
- `scripts/rfdetr_inference.py` — pose-only inference script that emits our
  keypoints JSON schema (frames[].skeletons[].keypoints[].x/y/visibility),
  plus optional `covariance` field per keypoint, plus our standard JSON
  envelope (fps, stride, primary_subject_id, etc).
- Two new tiers/columns in `make eval`: per-model headline metrics so
  YOLO11 vs RF-DETR is in the report side by side.
- Tracking comparison via `eval_tracking.py` on both.

**Decision after Phase 1:**
- F1 win or tie AND wall-clock ≤ 1.5× → Phase 2.
- F1 worse OR cost too high → stop, document, shelve. Same as the hook
  classifier negative.

### Phase 2 — Uncertainty experiment (only if Phase 1 promising)

Extend the keypoints JSON schema to carry the per-joint covariance
(additive, backward-compatible). Single concrete hypothesis: **revive the
impossible-extension gate, vetoing only when wrist covariance is large.**
Either it works on the golden corpus or it doesn't — one ratchet measurement.

### Phase 3 — OOD validation

3-5 unlabeled out-of-distribution clips (different athletes, camera
angles, possibly a public bag-work clip). Compare detection-count agreement
between the two models and tracking metrics, no labels needed. This is the
part that scouting's biggest blocker (out-of-distribution detection
unvalidated) depends on.

### Phase 4 — License compliance file

Write `LICENSES.md` documenting every dependency's license:
- The AGPL-3.0 / Apache 2.0 win that drives this whole evaluation.
- Flag the secondary one: `osnet_ain_x1_0_msmt17` weights trained on
  MSMT17 dataset (research-only license — gallery's latent legal question).
- All other deps (FastAPI, SQLAlchemy, Pydantic, boto3, OpenCV, Clerk,
  Stripe, DeepSeek...) — confirm permissive.

Useful for App Store review and any future investor/legal diligence
regardless of whether RF-DETR ships.

---

## Decision criteria for promotion (all must hold)

1. Detection F1 on `golden/core` ≥ YOLO11 baseline.
2. No fixture assertion fails in `make eval`.
3. Wall-clock per clip ≤ 1.5× YOLO11.
4. Tracking fragmentation on the busy-gym fixture clearly improved.
5. OOD detection agreement looks at least as good as YOLO11's intra-corpus consistency.

Any single failure → tune, downsize, or shelve.
