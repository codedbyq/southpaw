# Design: Intelligent Session Segmentation

> **Status:** Planned — **Phase 1 builds in beta week 2–3**, after golden-set
> tuning validates strike thresholds. Sequenced ahead of S&C v1
> (`strength-conditioning-v1.md`), which slides to week 3–4: segmentation was
> explicitly requested by multiple beta users and S&C benefits from it later
> (sets are just another segment type).
> **Owner:** —  ·  **Last updated:** 2026-06-09
> **Related code:** `backend/routers/uploads.py` (`MAX_DURATION_SECONDS`,
> multipart flow), `backend/modal_inference.py` (run_inference fan-out target,
> reaper pattern), `backend/models/session.py` / `clip.py`,
> `frontend/src/components/UploadModal.jsx`.

---

## 1. Problem & product assessment

Coaches and athletes record entire 20–60 min training sessions on a tripod.
The 5-minute clip cap forces them to export, scrub, and trim rounds by hand —
a coach filming a class will not do this six times per athlete per night;
they'll stop uploading. Multiple prospective beta users independently asked
for whole-session upload, which is the strongest demand signal available.

**Verdict: high-impact; adoption-critical for the gym/coach segment.**

- One 30-min upload → a fully formed session page with per-round metrics is
  the strongest "wow" the product can produce, and it feeds the existing
  retention loop (session feedback, trends, streaks) with zero user effort.
- Data quality *improves*: boundaries at real round edges make fatigue curves
  and round-over-round comparisons meaningful; rest/junk footage never enters
  strike metrics.
- Premium-worthy: processing cost scales with recording length, so
  duration-gating by tier is defensible, not arbitrary (§8).
- **Not before beta.** The launch promise is strike accuracy; this ships as
  the beta week-2/3 "new this week" release. Pre-beta we ship only the
  Phase-0 comms line (§10).

---

## 2. Core flow

```
Upload "full session recording" (new mode; caps 60 min / ~2 GB)
  → S3 + recordings row
  → Modal CPU pass: segment_recording (no GPU) → proposed segments + confidence
  → REVIEW UI (human-in-loop, always in v1): adjust / merge / split / label / discard
  → Modal CPU pass: split_recording (ffmpeg stream copy) → clips in an auto-created session
  → existing run_inference per clip, in parallel containers
  → existing session feedback aggregation (llm_summary_dirty already handles it)
```

**Design centerpiece: everything downstream is untouched.** Segments become
ordinary clips — idempotent runs, heartbeat/reaper, quality scoring, subject
selection, strike pipeline, and feedback are all inherited for free.

---

## 3. Segmentation MVP (Phase 1) — proxy pass, no GPU, no new ML

Runs in a Modal **CPU** container (~2–4 min for a 30-min video, pennies):

1. **Decode at 2 fps, 360p, grayscale** via ffmpeg pipe.
2. **Motion energy** — mean absolute frame difference per sample. Combat
   activity is unmistakably high-motion vs rest; this is the primary signal.
3. **Person presence** — `yolo11n` on CPU every ~2 s of video on the small
   frames (model already in the stack). Catches empty-frame / camera-at-floor
   spans and yields a per-segment person count for later type suggestions.
4. **Hysteresis state machine** over the smoothed motion signal:
   - separate enter/exit thresholds (no flapping at the boundary)
   - **min round length 60 s**; **merge active gaps < 20 s** (combinations
     pause naturally; coach instructions mid-round shouldn't split a round)
   - rest = low-motion span between 20 s and ~3 min
   - spans with no detected person are inactive regardless of motion
5. **Duration priors as scorers, never rules** — segments near 2:00/3:00/5:00
   with ~1:00 rests get a confidence boost; drilling and S&C ignore round
   clocks, so priors must not force-fit.
6. **Output:** proposed segments `{start, end, confidence, person_count}` +
   boundary thumbnails → review UI.
7. **Split:** confirmed segments cut with `ffmpeg -ss/-to -c copy`
   (keyframe-snapped, boundaries padded ±2–3 s, no re-encode — seconds, not
   minutes). Each becomes a clip with provenance back to the recording.

### Signals evaluated (and rejected/deferred)

| Signal | Reliability | Cost | Verdict |
|---|---|---|---|
| Motion intensity (frame diff) | High for active/rest | Trivial CPU | **MVP core** |
| Sparse person presence (yolo11n CPU) | High | Low | **MVP core** |
| Round-length priors | Medium (gyms vary) | Free | **MVP scorer only** |
| Tracked-athlete count | Medium (entry/exit flap) | Low | Phase 2 (type suggestion) |
| Camera/global motion | Medium | Trivial | Phase 2 (junk detector) |
| Audio: bell/timer beep (2–4 kHz onset) | Medium-high, **defeated by gym music** | Trivial | Phase 2 boundary *refiner*, never primary |
| Audio: silence/loudness/VAD | Low — music + chatter | — | Rejected |
| Strike frequency | Requires pose first — circular | GPU | Rejected (defeats the purpose) |

Gym music is the universal audio confounder; audio is never a primary signal.

---

## 4. Activity-type detection: ask, don't classify (v1)

The review UI asks the user to label each kept segment (one tap, prefilled
from the session's sport/type). Same decision as the S&C exercise picker and
the subject selector: converts a hard ML problem into a dropdown **and**
accumulates labeled segments — the third labeling flywheel (strike labels,
identity samples, now segment labels).

Phase-3 classification features (all computable from the proxy pass):
2 close persons → sparring/pads; 1 person + large static object with
impact-synced sway → bag; 1 person free-moving → shadow; low-amplitude
periodic motion → S&C set (hand off to the rep segmenter). Pads-vs-sparring is
genuinely hard pre-pose — accept user labels there indefinitely.

---

## 5. Schema

```sql
CREATE TABLE recordings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_user_id    text NOT NULL,
  s3_key           text NOT NULL,
  duration_seconds integer,
  status           text NOT NULL DEFAULT 'uploaded',
  -- uploaded | segmenting | review | splitting | complete | failed
  error_code       text,
  session_id       uuid REFERENCES sessions(id) ON DELETE SET NULL,
  heartbeat_at     timestamptz,            -- reaper coverage, same pattern as jobs
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE recording_segments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id      uuid NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
  start_seconds     double precision NOT NULL,
  end_seconds       double precision NOT NULL,
  confidence        double precision,
  person_count      integer,
  suggested_type    text,                  -- null in v1 (Phase 2 fills it)
  label             text,                  -- user-confirmed type
  status            text NOT NULL DEFAULT 'proposed',  -- proposed | confirmed | discarded
  original_bounds   jsonb,                 -- pre-correction bounds → boundary-model training data
  clip_id           uuid REFERENCES clips(id) ON DELETE SET NULL,
  thumbnail_s3_key  text
);

ALTER TABLE clips ADD COLUMN recording_id uuid REFERENCES recordings(id) ON DELETE SET NULL;
ALTER TABLE clips ADD COLUMN segment_start_seconds double precision;  -- provenance / re-split
```

`original_bounds` is the flywheel: every user correction in the review UI is a
labeled training example for the Phase-3 boundary model.

---

## 6. Cost analysis (why proxy-pass-first is non-negotiable)

30-min 1080p recording, T4, yolo11s, ~40–50% of footage rest/junk:

| | A: YOLO entire video | B: proxy pass → split → YOLO actives |
|---|---|---|
| GPU | ~25–35 min single run | ~12–18 min total, **parallel containers → ~3–4 min each** |
| $/recording | ~$0.30–0.50 | ~$0.15–0.25 + CPU pennies (**~45–60% saving**) |
| Wall-clock | 25–35 min | ~6–9 min incl. review |
| Other | 150 MB+ keypoints JSON; brushes the 1800 s Modal timeout; junk pollutes metrics; one failure kills all | per-round JSONs at current size; junk never analyzed; failures isolated per round |

Option A is not viable even ignoring cost (timeout + JSON size). B's complexity
price: two CPU functions, two tables, one review screen.

---

## 7. UX

- UploadModal gains "Full session recording" entry → progress: "Finding your
  rounds… 60%" over existing SSE plumbing.
- **Review screen:** horizontal filmstrip; shaded active segments with
  boundary thumbnails + duration badges; per segment: keep/discard, type
  dropdown (prefilled), drag handles; merge button between adjacent segments;
  split-at-playhead. Low-confidence boundaries get an amber "check this edge"
  highlight — **confidence as attention direction, not numbers**.
- CTA: "Looks right — process 5 rounds" (count = transparent cost). Discarded
  rests collapse to "4 rest periods skipped."
- **v1 is always review-first.** "Auto-process when confident" is a Phase-2
  opt-in, earned only after golden-recording boundary precision is proven.

---

## 8. Subscription strategy

Gate by recording duration (maps honestly to GPU cost):

| Tier | Recordings |
|---|---|
| Free | manual clips only, **plus one trial recording ≤ 15 min** (the feature sells Pro better than the pricing page) |
| Pro | ≤ 30 min |
| Elite | ≤ 60 min, future auto-process, priority queue |

**Fully unlocked for all testers during beta** — boundary-correction data and
gym-workflow feedback are worth more than gating 50 users.

---

## 9. Failure modes

| Failure | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Coach talk / lull mid-round → false split | High | Round fragmented | 20 s merge-gap + 60 s min-round; one-tap merge in review |
| Active rest → rounds merged | Medium | Two rounds as one | Duration prior flags 7-min "rounds" low-confidence; split-at-playhead; Phase-2 bell refiner |
| Camera at floor / repositioned | Medium | Junk segment | Person-presence gate marks no-person spans inactive |
| Water-break variance | High | Boundary jitter ±10 s | ±2–3 s split padding; cosmetic — metrics are per-segment |
| Athletes entering/exiting frame (classes) | High | Presence flapping | Hysteresis + smoothing; in-clip multi-person already handled by subject selector |
| Gym music | Certain | None by design | Audio never primary |
| Long upload on gym Wi-Fi | Medium | Upload failure | Existing multipart per-chunk retry; just more parts |
| Segmentation wrong end-to-end | Low-med early | Trust hit | Review-first: user confirms before any GPU spend; corrections logged |

---

## 10. Roadmap

- **Phase 0 — pre-beta (~0.5 d, rides with the how-to-film screen):** guidance
  line "Record rounds as separate clips for now — full-session upload is
  coming during the beta." Friendlier 5-min-cap error pointing to the same
  message. *No segmentation code before beta.*
- **Phase 1 — beta week 2–3 (~1 week):** recording upload mode + caps;
  `segment_recording` CPU pass; review UI; `split_recording` stream-copy;
  auto-session + fan-out; reaper coverage for `segmenting`/`splitting`;
  **golden recordings:** hand-mark boundaries on ~5 real gym recordings.
  **Ship bar: 90% of boundaries within ±5 s; zero merged rounds after review.**
- **Phase 2 — post-feedback:** bell/beep boundary refiner; auto-process opt-in
  for high-confidence runs; segment-type suggestion from person count/motion
  stats; tier gating switched on; S&C integration (rep segmenter consumes
  `strength` segments).
- **Phase 3 — ML:** boundary model trained on accumulated review corrections;
  activity classifier on proxy-pass features; within-round highlight detection
  (exchanges, knockdowns) as a coach-facing premium layer.

---

## 11. Decisions

| # | Decision | Status | Notes |
|---|---|---|---|
| G1 | Proxy pass on CPU before any GPU; never YOLO the whole recording | ✅ | §6 — cost, timeout, JSON size, data quality all agree |
| G2 | Review-first in v1; auto-process is earned in Phase 2 | ✅ | Trust + tier caps; corrections feed the boundary model |
| G3 | Audio never a primary signal | ✅ | Gym music; bells = Phase-2 refiner only |
| G4 | User labels segment types; no activity classification in v1 | ✅ | Third labeling flywheel; same call as exercise picker / subject selector |
| G5 | Segments become ordinary clips (stream-copy split) | ✅ | Downstream pipeline untouched; provenance via clips.recording_id |
| G6 | Duration priors score, never force | ✅ | Drilling/S&C ignore round clocks |
| G7 | Unlock for all beta testers; tier-gate at public launch | ✅ | Data > gating at n=50 |
| G8 | Ships beta week 2–3, ahead of S&C v1 | ✅ | Explicit user demand; S&C consumes segments later |

## 12. Open questions

- Auto-process confidence threshold (Phase 2) — what boundary-error rate earns it?
- Class settings: one recording containing *different athletes* per round —
  does each round become a clip in whose session? (v1 assumes one athlete/owner.)
- Mobile recording lengths/file sizes — does 60 min @ 4K (~10+ GB) need a
  client-side downscale-on-upload path before Elite caps are honest?
- Should discarded rest segments be soft-kept (re-claimable for a week) or
  dropped at split time? (v1: never split → nothing stored.)

## 13. Iteration log

- **2026-06-09** — Initial spec from product/technical design review. Proxy-pass
  MVP, review-first UX, user-labeled segments, beta week-2/3 sequencing ahead
  of S&C v1.
