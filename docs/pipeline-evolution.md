# Pipeline Evolution: Rules → Hybrid → Learned

Status: reviewed June 2026, grounded in the golden-corpus tuning sessions (PRs #48–#52).
Companion to [product-strategy.md](product-strategy.md) (product side) and
[subject-identity-and-reid.md](subject-identity-and-reid.md) (re-ID spec).

**Where we stand, measured:** 9 usable labeled clips + 2 tracking fixtures, 305 verified
strikes. Detection precision 0.41 → 0.57, recall 0.91, F1 0.70 after threshold tuning
(rules-4). Hook F1 0.24 with two naming variants measured-and-rejected. Knee/uppercut:
~5 labels each, 0 recall, no detection rule exists. Jab/cross flips concentrated in
two-person footage with stance detection verified correct.

**Three findings shape everything below:**

1. **The single-frame ceiling is real and measured.** Impact-frame keypoints are the
   *worst* frames (wrist excursion on real impacts — the rejected extension-cap gate
   proved it), and hook-vs-wide-straight is a *path* distinction invisible at any single
   instant. No threshold tuning on peak-frame geometry will fix hooks.
2. **The sparring type errors live in the identity layer, not the classifier.** Stance is
   now correct on both sparring fixtures; the residual jab/cross flips co-occur with
   two-person clutter — left/right keypoint side-swaps and track contamination. Tuning
   the classifier against identity noise optimizes the wrong layer.
3. **The corpus is one southpaw athlete.** Every tuned threshold (chamber 0.8, stride
   veto 2.0, velocity floor 4.0) is fitted to one body, one gym, a handful of camera
   angles. The current numbers are honest for this corpus and *unvalidated for everyone
   else*. Diversity is now worth more than volume.

---

## Part 1 — Root Cause Analysis

### Why shape-based hook rules fail

- **The peak frame is corrupted by the thing being measured.** Impact = maximum wrist
  velocity = maximum motion blur and keypoint excursion. Measured: anatomically
  impossible arm extensions (1.5–2.1 torso-lengths) on *true* strikes.
- **Hook vs wide straight is a trajectory class, not a pose class.** At impact, a wide
  jab and a short hook can produce near-identical wrist/elbow geometry. They differ in
  the path: hooks arc (high tangent-direction change, low chord/path straightness);
  straights are radial (wrist travels along the shoulder→target line).
- **2D projection aliases shapes by camera angle.** A straight viewed obliquely is
  laterally compact; a hook viewed head-on looks straight. Single-frame x-offsets
  inherit the full ambiguity; trajectory shape in a body-centric frame inherits much
  less of it.

**Signals that should replace static geometry** (in measured-leverage order):
wrist-path straightness ratio (chord length / path length over the strike window);
total tangent turning angle; elbow path and elbow elevation *during* the strike (not at
peak); shoulder-line rotation Δ and its lag vs hip rotation Δ; velocity direction at
peak relative to the approach vector (radial = straight, tangential = hook).

### Jab/cross confusion: wrong layer confirmed

Strike classification is (mostly) not the bug. Evidence: stance detection verified
correct on both sparring clips post-fix; flips concentrate in multi-person footage;
the two fixtures show identity failure directly (subject swap mid-clip; 178 fragment
IDs in 11 seconds).

**Diagnosis instrumentation to add (cheap, do regardless):**

1. **Eval slices by clutter.** Report type accuracy separately for single-subject vs
   multi-subject clips. One number quantifies how much of the type-error budget is
   identity-driven.
2. **Per-strike identity context.** At detection time, store: minimum inter-subject
   distance in the strike window, count of skeletons within 1.5 torso-lengths, and
   keypoint-confidence minima. This tags every strike with "was the scene clean," and
   becomes a confidence input and an eval slice key.
3. **Left/right consistency monitor.** A side-swap appears as a discontinuity where the
   left and right wrist positions exchange between consecutive frames (both keypoints
   jump by ≈ the inter-wrist distance). Count these per track; flag strike windows
   containing one. This is detectable *today* with no model.

**Verdict: re-ID work outranks further classifier tuning for sparring footage** — but
not for everything (see prioritization). Single-person footage is clean, and most of
the corpus's remaining FP budget is there.

---

## Part 2 — Trajectory Feature Schema

Evaluate a strike as a temporal window, not a frame. All coordinates body-centric:
origin mid-hip, x-axis along the detected facing direction (facing inference exists
post-rules-3), distances in torso-lengths. This kills camera-distance and left/right
facing variance at the representation layer.

**Window:** `t_peak − 0.5s` to `t_peak + 0.4s` (chamber/launch + impact + retraction).
Resample the limb path to **16 points** (fps-independent — the corpus mixes 30/60fps).
Skip the window if track gaps exceed 0.4s inside it (reuse `_window_start` semantics).

**Schema v1 (per detected strike, stored as JSON alongside the detection):**

```
strike_features_v1:
  meta:        rules_version, fps, clip_type, stance, subject_id
  path:        wrist (or ankle) 16×2 resampled, body-frame; elbow (knee) 16×2
  kinematics:  speed profile (16), peak_speed, time_to_peak_frac,
               launch_accel (first-third mean), impact_decel (post-peak min)
  geometry:    straightness = chord/path_len; total_turn_deg (sum of tangent Δ);
               peak_extension; extension_curve (rise, drop_ratio, symmetry);
               vertical_frac = |Δy|/path_len (uppercut/knee separator)
  rotation:    shoulder_line_Δdeg, hip_line_Δdeg, hip_to_shoulder_lag_ms
  context:     guard_other_hand_below_shoulder (bool), body_speed (stride veto input),
               support_foot_speed + knee_chamber (kicks),
               clutter: min_subject_dist, n_subjects_near, kp_conf_min/mean,
               lr_swap_flag (Part 1 monitor)
  quality:     window_gap_ms, frames_used
```

**Multi-frame confidence** replaces the current 3-term score: combine velocity margin,
window keypoint confidence (min, not mean — dropouts hide in means), pattern
completeness, straightness consistency, and the clutter/lr_swap flags as penalties.
Calibrate per class on the corpus (isotonic or simple binning) so 0.8 means 80% across
classes — today a 0.99-confidence phantom is common (measured).

**Critical decision: compute and store this at processing time for every detection,
starting now** — even before anything consumes it. Every label the flywheel collects
then becomes an (features, label) training row retroactively, with no reprocessing.
This is the bridge from rules to ML, and it's also better rules *today* (the gates
shipped this week are crude scalar projections of this schema).

---

## Part 3 — Knee, Elbow & Uppercut Strategy

**Dataset math (rule-of-thumb for trajectory features this clean):**

| | minimum viable | recommended |
|---|---|---|
| Fit rule thresholds (medians + sweeps, like kick gates) | ~30–50 per class | 75 |
| Lightweight classifier (GBM/logistic on schema v1) | ~150–300 per class | 500+ |

~5 examples supports neither. **But don't wait passively — collect actively.** One
30-minute targeted bag session ("3 rounds heavy on knees, 3 on uppercuts, 2 on elbows")
yields 50–100 examples per class, labeled in under an hour with the existing tool. For
beta users: a "drill of the week" prompt does the same at scale and is product, not
chore (see Part 4). Diversity checklist before trusting any fitted rule: ≥2 camera
angles, ≥2 athletes, both axes (lead/rear), bag + pads contexts. Today's corpus fails
the ≥2-athletes bar for *every* class — the single most important collection gap.

**Build order, opinionated:**

1. **Uppercut first, after ~30 examples** — it's currently *structurally undetectable*:
   the punch candidate rule requires `|dx| > |dy|`, which excludes vertical punches by
   construction. The fix is a third candidate class (wrist, `dy < 0` dominant, near
   torso, retraction required), gated like kicks. Without it, uppercut recall is 0
   regardless of data volume.
2. **Knee second (~30–50 examples)** — likely the cleanest signature of the three: knee
   keypoint drives up/forward toward hip height *without* the ankle whip of a kick
   (ankle stays under knee — directly separable from kick chamber using features
   already computed for the kick gates).
3. **Elbow last (50+ examples)** — short range, wrist/elbow co-travel, heavy occlusion
   at impact. Worth a rule attempt only after schema v1 exists; may be the first class
   that genuinely needs the ML path.

---

## Part 4 — Labeling Strategy: Embed, Don't Bolt On

Principle learned this week: **the labeling tool is also the debugging tool, the eval
tool, and the trust-building tool.** Keep one annotation surface (LabelPlayerPage) and
feed it from many natural product moments:

- **Athlete verify pass (highest value/effort).** After processing, a 60-second
  "verify your session" flow: the player auto-advances detection-to-detection with
  ✓/✗/type keys (the labeling UX, athlete-skinned). Frame it as accuracy, not chores —
  "your stats are only as good as confirmed strikes." Verified clips auto-nominate for
  the golden set when: athlete-verified + single subject + subject_confidence ≥ 0.7.
- **Coach review = premium labels.** Coach timestamped comments already exist; add a
  one-click "correct this detection" affordance in the coach review player. Coach
  labels get a provenance weight above athlete labels (`strike_labels.source` already
  distinguishes them).
- **Active-learning queue in the admin tool.** Sort the label queue by expected
  information: low-confidence detections, clips from underrepresented slices (new
  athlete, new camera angle, sparse classes), rules-vs-model disagreements once a
  shadow model exists. 10 detections/day of *chosen* labels beats 100 random.
- **Feints and checks taught us the policy pattern:** every labeling-policy decision
  (axis-not-slot, checks-are-defense, feints-count) is written into the tool's key map
  comments and the export semantics — policy lives in code, not in memory.

**Held-out discipline starts now (self-critique):** this week's thresholds were tuned
on 100% of the corpus. From the next labeled batch onward: new clips land in a held-out
validation pool first; thresholds get fitted on the training pool only; the eval
reports both. Otherwise the golden set degrades into a fitting set and the numbers go
quietly dishonest.

---

## Part 5 — Regression Framework

Formalize what already exists (golden_eval + fixtures + RULES_VERSION) into:

```
golden/
  core/              stable verified clips — the headline metrics set
  holdout/           never tuned against; reported separately
  regression/
    jab-cross-sparring/     IMG_7678 pair
    tracking-id-switch/     IMG_6336 (subject→pad-holder, conf 0.569)
    tracking-fragmentation/ IMG_0312 (178 ids / 11s)
    skip-step-kicks/        (carve from IMG_0113 era clips)
  manifest.json      per fixture: failure mode, expected metrics, assertions
```

- **Per-fixture assertions, not just aggregates:** e.g. `IMG_0113: FP ≤ 25, recall ≥
  0.9`, `IMG_6336: subject_confidence < 0.7 must flag`. Aggregate F1 can improve while
  a specific failure regresses; assertions catch that.
- **Metrics tracked per release:** corpus P/R/F1 (core and holdout separately),
  per-class F1, per-clip-type slice (bag/shadow/pads/sparring), per-fixture assertion
  pass/fail, count MAE. One JSON report per release, committed (reports are small and
  shareable; the gitignored footage-derived JSONs stay in S3).
- **The ratchet rule:** no classifier change merges if core F1 drops or any fixture
  assertion fails, without an explicit override note in the PR. New failure discovered
  → fixture added *before* the fix (test-first, combat edition).
- **CI shape:** golden JSONs live in a private S3 prefix; a `make eval` target fetches
  and runs `golden_eval` + assertions. Run locally pre-merge now; wire to GitHub
  Actions when the corpus stabilizes. `pipeline_version` on every clip (exists) keeps
  production data lineage honest; `scripts/reprocess_clip.py` + diff validates deploys.

---

## Part 6 — Dataset Flywheel at 50 Users

**Store now, valuable later (in order):**

1. **Trajectory features per detection** (Part 2) — converts every future label into a
   training row. The single most valuable schema addition on the books.
2. Keypoints JSONs (already stored) — enables re-extraction when the feature schema
   evolves, and offline replay of any future model. Never delete these.
3. Labels with provenance + policy version (exists: source field, latest-wins) — add
   the labeling-policy version so future training can filter policy changes.
4. Identity/clutter context per strike (Part 1) — re-ID training pairs come from
   identity_samples + the side-swap monitor, free.
5. Outcome-ish signals: athlete-verified flags, coach correction rates per clip —
   these become quality weights for training.

**The loop:** upload → process (features stored) → athlete verify pass (labels) →
low-confidence/disagreement items to admin queue (chosen labels) → coach reviews
(premium labels) → weekly eval on the growing corpus (dashboard: per-class F1 trend,
slice gaps) → threshold/model updates gated by the ratchet → ship → repeat.
**Active-learning trigger thresholds:** confidence in [0.45, 0.7] (the ambiguous band),
subject_confidence < 0.7, lr_swap_flag set, any underrepresented slice. **What's most
valuable at 50 users:** verified *sparring* clips (hardest + product-critical), any
non-southpaw athlete (corpus bias), knees/elbows/uppercuts (scarcity), and every clip
from a camera angle the corpus hasn't seen.

---

## Part 7 — Prioritization

| # | Initiative | Impact | Effort | Risk | Depends on |
|---|---|---|---|---|---|
| 1 | **Trajectory features + storage** | Very high (unblocks hooks, uppercut, knee, ML path; improves confidence now) | ~1 wk | Low | — |
| 2 | **Regression formalization** (tiers, manifest, assertions, holdout) | High (protects everything else) | 1–2 days | None | — |
| 3 | **Targeted data collection** (knee/uppercut/elbow sessions; ≥1 more athlete) | High (corpus bias is the biggest honesty gap) | Hours, ongoing | None | — |
| 4 | **ReID / identity** | Very high for sparring (the product moat) | 2–3 wks | Medium | Benefits from #1's clutter instrumentation |
| 5 | **Hook trajectory classifier** | Medium-high (hook F1 0.24 → est. 0.5+) | ~1 wk | Low | #1, #3 |
| 6 | **Uppercut detection** (new candidate class) | Medium | days | Low | #1, #3 (~30 examples) |
| 7 | **Knee detection** | Medium | days | Low | #1, #3 (~30–50 examples) |
| 8 | **Labeling infra increments** (athlete verify pass, AL queue) | Medium (compounds) | ~1 wk | Low | — |
| 9 | New strike classes (elbows, teep split, defense actions) | Lower now | — | — | All of the above |

**Single highest-leverage investment: trajectory feature extraction stored at
processing time.** It is the only item that simultaneously (a) raises today's rule and
confidence quality, (b) is the prerequisite for all four weak classes, (c) converts the
entire future label stream into training data retroactively, and (d) is the rails for
the rules→ML transition without a rewrite. The regression formalization (#2) is two
days and should land first as the safety net; data collection (#3) runs in parallel
forever.

Sequence: **#2 → #1 → (#3 ‖ #6 ‖ #7 as data arrives) → #4 → #5 → #8 throughout.**

---

## Part 8 — Target Architecture (12 months)

```
video ─ pose model (upgrade seam: yolo11s-pose → RTMPose/wholebody when feet matter)
      ─ tracking (ByteTrack-class) ── ReID layer:
            • per-athlete embedding gallery (identity_samples — table exists)
            • track stitching across fragmentation/occlusion
            • LR keypoint-swap repair  • per-track identity confidence
      ─ body-frame normalization (facing-aware, torso-normalized — exists in pieces)
      ─ EVENT PROPOSER (recall-oriented motion peaks; today's velocity rules, loosened)
      ─ TRAJECTORY FEATURES (schema v1, stored per proposal — the contract)
      ─ STRIKE CLASSIFIER (per-class, versioned, swappable):
            phase 1 rules-on-features → phase 2 GBM/logistic per class
            → phase 3 temporal model (TCN/small transformer on keypoint windows)
      ─ confidence calibration (per-class, corpus-fitted)
      ─ persistence + metrics + LLM payloads
      └─ feeding: dataset manager (features+labels, splits, lineage)
                  eval pipeline (golden tiers, ratchet, weekly corpus runs)
```

**The architectural move that makes the transition safe: split detection into a
recall-oriented proposer and a precision-oriented classifier.** Today's velocity rules
become the proposer (slightly loosened — recall is already 0.91); all precision logic
moves into the classifier stage operating on stored features. Then:

- **Phase 1 (now → +3 mo):** classifier = current gates, re-expressed over schema v1.
  Identical behavior, new rails. ReID v1 lands. Holdout discipline + ratchet active.
- **Phase 2 (+3 → +6 mo):** train per-class GBMs on accumulated (features, label) rows.
  Run in **shadow mode** on production (log disagreements with rules — free active
  learning). Promote per class behind versioned flags when a class beats rules on
  holdout: ship the ML hook classifier while rules keep handling jabs. Champion/
  challenger, never big-bang.
- **Phase 3 (+6 → 12 mo):** with ~10k labeled strikes, a small temporal model over raw
  body-frame keypoint windows replaces hand features for classification; the feature
  schema remains for explainability, metrics, and the coaching layer. Pose model
  upgrade (wholebody) slots in at its seam without touching anything downstream of
  normalization.

Production safety throughout: proposer stability (recall is sacred), per-class
promotion, version lineage on every strike row (`pipeline_version` exists), instant
rollback by flag, and the regression ratchet in front of every merge.

**The bet, stated plainly:** the moat isn't a clever model — it's the only labeled,
versioned, body-frame-normalized combat-strike dataset with verified ground truth and
regression fixtures, growing as a side effect of a product people use. Architecture
exists to compound that asset safely.
