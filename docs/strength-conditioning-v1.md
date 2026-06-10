# Design: Strength & Conditioning v1 (rep analysis)

> **Status:** Planned — build **after** golden-set tuning lands and the strike
> classifier thresholds are validated on real footage. Target: fast-follow
> during beta week 2 ("new this week" release), not launch scope.
> **Owner:** —  ·  **Last updated:** 2026-06-09
> **Related code:** `backend/services/strike_classifier.py` (smoothing/normalization
> machinery to reuse), `backend/services/clip_metrics.py`, `backend/services/feedback.py`,
> `backend/modal_inference.py`, `frontend/src/components/UploadModal.jsx`,
> `frontend/src/components/CanvasPlayer.jsx`.

---

## 1. Problem & thesis

The gym beta audience is wider than fighters — everyone lifts. The pose
pipeline (upload → YOLO11 → tracking → quality scoring → LLM feedback) is
sport-agnostic; what's combat-specific is only the *event detector* (strikes)
and the *prompt context*. Adding S&C means swapping those two pieces, not
building a new product.

**Core design decision: don't detect the exercise — ask.** Open-set exercise
recognition from 2D keypoints is the same class of problem where rules-based
strike detection v1 failed (confident wrong answers → trust damage). The user
already picks a sport at upload; when sport = `strength`, they also pick the
exercise from a short list. This converts a hard ML problem into a dropdown,
and every picked label accumulates training data for auto-suggestion later —
the same flywheel pattern as strike labels and identity samples.

---

## 2. v1 scope

### Exercises (launch set)

Only movements where a single 2D side-ish view gives reliable keypoints:

| Exercise | Primary angle | Depth/ROM signal | Notes |
|---|---|---|---|
| `squat` | hip + knee flexion | hip crease vs knee y | the flagship |
| `deadlift` | hip hinge (shoulder-hip-knee) | bar path proxy: shoulder vertical travel | hinge vs squat distinction via shin angle |
| `push_up` | elbow flexion | chest (mid-shoulder) y travel | floor-level framing acceptable |
| `lunge` | front-knee flexion | rear-knee y minimum | flags l/r asymmetry naturally |
| `overhead_press` | elbow + shoulder | wrist y above nose | standing only in v1 |

**Explicitly excluded from v1** (revisit with data, not optimism):
- `bench_press` — subject horizontal + bar/bench occlusion; pose quality collapses.
- `running` / conditioning intervals — different framing + metric model entirely.
- Olympic lifts — too fast/multi-phase for first pass.
- Anything the user picks as `other` — processed for pose overlay + clip quality
  only, **no rep metrics, no LLM coaching claims** (honest beats wrong).

### Out of scope for v1
- Exercise auto-detection (later: "Looks like a squat — confirm?" suggestion,
  trained on picker labels; same confidence-gated philosophy as subject auto-pick).
- Barbell/load tracking, velocity-based training (VBT) claims, %1RM estimates.
- Form *prescriptions* beyond what keypoints support (e.g. no spine-flexion
  claims — COCO has no spine landmarks; see §6 guardrails).

---

## 3. Data flow (what changes, what doesn't)

```
Upload (sport=strength + exercise picker) ──► same S3 / multipart path
        │
Modal run_inference ── unchanged: pose, tracking, quality score, thumbnail
        │
   if clip_type == 'strength':
        skip strike classifier ──► run rep_segmenter (new, pure Python)
        │
S3 keypoints JSON: frames + reps[] (instead of strikes[])
PG: reps rows (mirrors strikes table)
        │
LLM feedback: same generate_feedback() plumbing, S&C prompt context,
              reps block in payload, same data_quality gating
        │
Player: rep timeline (reuse strike-timeline component), per-rep list,
        rep ✓/✗ labeling (reuse strike_labels pattern)
```

Reused without modification: upload limits, EXIF/720p/60fps handling, ByteTrack,
subject scoring + selector (spotters/other lifters in frame!), pose quality
score + banner, heartbeat/reaper/diagnostics, consent gating.

---

## 4. Rep segmentation (the new primitive)

One generic algorithm covers all five exercises; per-exercise config only.
Lives in `backend/services/rep_segmenter.py`, pure Python over the frames JSON
(same contract as `strike_classifier.py` — golden-harness replayable, no GPU).

### Algorithm

1. **Signal extraction** — per exercise, one primary scalar signal per frame
   from the subject's smoothed keypoints (One-Euro/EMA reuse):
   - squat / lunge: knee flexion angle (hip–knee–ankle)
   - deadlift: hip angle (shoulder–hip–knee)
   - push_up: elbow angle (shoulder–elbow–wrist)
   - overhead_press: wrist height relative to nose, in torso-lengths
   Use the side (left/right) with higher mean keypoint confidence; record which.
2. **Normalize + smooth** — torso-length normalization for positional signals;
   angles are scale-free already. Time-based smoothing window (~150 ms).
3. **Cycle detection** — find alternating local minima/maxima of the signal with:
   - **amplitude floor** (per-exercise, e.g. ≥40° knee-angle excursion for squat
     — kills half-reps and bar-walkouts),
   - **period floor** (≥1.0 s per rep — kills jitter oscillation),
   - **hysteresis** between top/bottom thresholds (prevents double-count at
     the sticking point).
4. **Rep records** — for each cycle emit timestamps for top→bottom→top, then
   derive metrics (§5).
5. **Per-rep confidence** — same recipe as strikes:
   `0.4·amplitude_margin + 0.35·mean_kp_conf(involved joints) + 0.25·period_plausibility`.
   Below 0.4 → JSON-only, excluded from PG/metrics/LLM (constant shared with
   `MIN_PERSISTED_CONFIDENCE`).
6. **Set detection** — gap > 15 s between reps splits sets. Sets get indices;
   set-level aggregates feed the fatigue story.

### Known hard cases (accept, flag, don't guess)
- Quarter-rep grinders: amplitude floor will drop them — correct behavior,
  surfaced as "we counted N full reps" wording in feedback.
- Occluded side (plates blocking near leg): side-selection by confidence
  mitigates; if both sides < MIN_KEYPOINT_CONF for >30% of frames, suppress rep
  metrics and lean on the quality banner.
- Multiple people (spotter, adjacent racks): existing subject scoring already
  handles primary selection; presence filter keeps the picker clean.

---

## 5. Metrics (per rep → per set → per clip)

Per rep (stored on the row):
- `duration_seconds`, `eccentric_seconds`, `concentric_seconds` (tempo split)
- `rom` — signal excursion (degrees, or torso-lengths for press)
- `depth_ok` (squat/lunge only): hip-crease y below knee y at bottom → bool
- `symmetry` (lunge/push_up): left-vs-right involved-joint angle delta where
  both sides visible, else null
- `confidence`

Per set / clip (computed in `feedback.py` aggregation, mirrors `_aggregate_strikes`):
- rep count per set, rest seconds between sets
- tempo drift across the set (last-3 vs first-3 rep concentric time → the
  "bar speed died" story without claiming velocity)
- ROM consistency (std of rom across reps)
- depth rate (squats: % reps below parallel)

These are the S&C analogs of strikes/min, guard rate, and the fatigue curve —
same payload shape, same omit-if-low-confidence rules.

---

## 6. LLM payload & guardrails

- `build_clip_summary` branches on `clip_type == 'strength'`: emits a
  `reps` block (counts, tempo, ROM, depth, set structure, drift) instead of
  the strikes block. `data_quality` block unchanged.
- New `STRENGTH_CONTEXT` system-prompt section + per-exercise coaching context
  (squat: depth + knee tracking; deadlift: hinge vs squat pattern; etc.).
- **Hard guardrails in the prompt** (extends the existing CONFIDENCE POLICY):
  - never estimate load, 1RM, or bar speed — not measured
  - no spine/back-rounding claims — no spine keypoints exist
  - exercise identity comes from the athlete, not inference — phrase as
    "your squat set", never "this appears to be a squat"
  - `other` exercise → encouragement + quality/setup feedback only

---

## 7. Schema

```sql
-- mirror of strikes; same job-scoped lifecycle, same idempotent wipe-on-rerun
CREATE TABLE reps (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subject_id         integer,
  set_index          integer NOT NULL,
  rep_index          integer NOT NULL,          -- within set
  timestamp_seconds  double precision NOT NULL, -- bottom of the rep
  frame_index        integer NOT NULL,
  duration_seconds   double precision,
  eccentric_seconds  double precision,
  concentric_seconds double precision,
  rom                double precision,
  depth_ok           boolean,
  symmetry           double precision,
  confidence         double precision,
  side_used          text                       -- 'left' | 'right'
);
CREATE INDEX idx_reps_job ON reps(job_id);

ALTER TABLE clips ADD COLUMN IF NOT EXISTS exercise text;
-- 'squat' | 'deadlift' | 'push_up' | 'lunge' | 'overhead_press' | 'other'

-- rep labels reuse strike_labels verbatim? No — separate table, same shape,
-- to keep training data domains clean:
CREATE TABLE rep_labels (LIKE strike_labels INCLUDING ALL);  -- adjust FK to reps
```

`sessions.session_type` gains `'strength'`; sport selector gains
`strength` (label: "Strength & Conditioning") with its own tag color.

---

## 8. Frontend

- **UploadModal**: when sport = `strength`, show exercise picker (required,
  6 options incl. Other). Stored on the clip; per-clip editable on PlayerPage
  like notes.
- **PlayerPage / CanvasPlayer**: rep markers on the existing timeline component
  (one tick per rep, sets visually grouped); per-rep list in the right panel
  (time, tempo, ROM, depth flag) replacing the strikes tab for strength clips;
  ✓/✗ labeling affordance reused for reps ("missed rep" at playhead included).
- **Metrics panel**: reps / sets / avg tempo / depth rate replace the strike
  metric rows.
- **SessionCard/stats**: strength sessions show rep totals instead of strikes
  (guard: don't mix strike and rep counts in one aggregate).

---

## 9. Validation (gate to ship, same bar as strikes)

- Extend the golden harness: `golden_eval.py` grows a `--mode reps` path (or a
  sibling script) replaying `rep_segmenter` on keypoints JSONs vs hand labels —
  count-exact match per set, tempo within ±0.3 s.
- Golden S&C set: ~8 clips — 2 squat (one deep, one shallow/grindy), 1 deadlift,
  1 push-up, 1 lunge, 1 OHP, 1 multi-person gym floor, 1 garbage/`other`.
- Ship bar: rep-count exact on ≥80% of golden sets, never overcounts by >1.
  Overcounting is the trust-killer (everyone knows how many reps they did);
  bias the amplitude/hysteresis thresholds toward undercount.

---

## 10. Decisions

| # | Decision | Status | Notes |
|---|---|---|---|
| S1 | User picks exercise; no auto-detection in v1 | ✅ | Picker labels train future auto-suggest (flywheel) |
| S2 | One generic cycle-detector + per-exercise config, not per-exercise detectors | ✅ | Same maintainability bet as the strike classifier post-pass |
| S3 | Bench + running excluded from v1 | ✅ | Occlusion / framing; revisit with golden data |
| S4 | `other` = pose overlay + quality only, zero coached claims | ✅ | Honest beats wrong |
| S5 | Bias rep counting toward undercount | ✅ | Overcount destroys trust instantly |
| S6 | Separate `reps` + `rep_labels` tables (mirror, don't overload strikes) | 🟡 | Keeps domains + training data clean; slight schema duplication accepted |
| S7 | Ships as beta fast-follow (week 2), after golden tuning + dry run | ✅ | Combat accuracy is the launch promise; S&C is the mid-beta buzz moment |

## 11. Effort estimate

| Piece | Est. |
|---|---|
| rep_segmenter + per-exercise configs + synthetic tests | 1.5–2 d |
| Modal branch + reps persistence + migration | 0.5 d |
| Payload + prompt + guardrails | 0.5 d |
| Upload picker + player rep timeline/list + labeling reuse | 1–1.5 d |
| Golden S&C clips + harness mode + tuning pass | 1 d (incl. user labeling time) |
| **Total** | **~4.5–5.5 d** |

## 12. Open questions

- Does the gym want named *workouts* (session of mixed exercises) in v1, or is
  one-exercise-per-clip acceptable? (v1 assumes per-clip.)
- Tempo display convention — seconds (3.1s ecc / 1.2s con) vs gym notation (31X0)?
- Should depth_ok threshold be configurable (powerlifting parallel vs Oly depth)?
- Free-tier clip limit interactions — lifters upload more, shorter clips.

## 13. Iteration log

- **2026-06-09** — Initial spec. Scoped v1 to five exercises, user-picked,
  generic cycle detector, sequenced after golden-set tuning as beta week-2
  fast-follow.
