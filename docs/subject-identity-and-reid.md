# Design: Subject Selection & Athlete Identity (ReID)

> **Status:** Living design doc — expect iterations.
> **Owner:** —  ·  **Last updated:** 2026-06-07
> **Related code:** `backend/modal_inference.py`, `backend/services/clip_metrics.py`,
> `backend/routers/clips.py` (`/clips/:id/select-subject`), `frontend/src/pages/PlayerPage.jsx`,
> `frontend/src/components/CanvasPlayer.jsx`, `backend/models/clip.py` (`selected_subject_id`).

---

## 1. Problem

Clips can contain more than one person — a sparring partner, plus bystanders in the
background. Pose + strike detection runs on **everyone**, so without a notion of "which
person is the athlete," the athlete's metrics (strike count, guard-drop rate, arm
extension, combos, fatigue) and the AI feedback get polluted by the opponent or
passersby. We need to (a) pick the right subject by default, (b) let the user correct it,
and (c) eventually **remember** the athlete so the default is right automatically.

This is fundamentally a **multi-object tracking + person re-identification (ReID)** problem.

---

## 2. Current implementation (shipped / in-progress)

**Pipeline (`modal_inference.py`)**
- YOLO11 pose + **ByteTrack** (via `supervision`, pinned `<0.30`) → persistent `tracker_id`
  per subject across frames.
- Each strike is tagged with `subject_id`.
- **Primary-subject heuristic:** the subject with the largest summed on-screen bbox area
  over the clip (the foreground athlete; background bystanders barely register).
- Only the **primary subject's strikes** are written to Postgres → all existing
  metric/feedback/stats queries stay correct with zero changes.
- The **full keypoints JSON** keeps *all* subjects (tagged with `subject_id`) + a
  `subjects` summary + `primary_subject_id`, so re-selecting a subject is a cheap
  filter-from-JSON, not a re-run of YOLO.
- Per-subject `recovery_seconds`; head-movement + stance computed for the primary subject.

**Data model**
- `clips.selected_subject_id INTEGER NULL` — the currently selected subject.

**API**
- `POST /clips/:id/select-subject {subject_id}` — re-derives strikes for the chosen subject
  from the JSON, rebuilds Strike rows, recomputes head/stance, regenerates clip feedback,
  marks the parent session dirty.

**Frontend**
- `PlayerPage` shows "Fighter N · {strikes}" chips when >1 subject; selecting one calls the
  endpoint and reloads metrics/strike-list/feedback.
- `CanvasPlayer` filters the strike timeline to the selected subject and reports available
  subjects.

**Known UX gap:** the chips are abstract ("Fighter 1/2") — the user can't tell which chip
maps to which person on screen without clicking and watching the metrics change.

---

## 3. Near-term: make *identification* obvious (next build)

Chosen direction: **color-coded skeletons + matching chips (+ hover preview).** No backend.
- Each tracked subject's skeleton drawn in a distinct palette color.
- Selector chips color-matched (a colored dot/border per chip).
- Hovering a chip highlights that subject on the current frame (commit only on click).
- **Presence filter:** only list subjects with meaningful presence (e.g. ≥ N frames or ≥1
  strike) so fragmented/background IDs don't clutter the picker.

Alternatives considered (deferred): click-the-fighter-on-video (needs a "select mode" because
the canvas passes clicks to the video controls); per-fighter thumbnail crops (most
unambiguous, best on mobile, but needs backend crop+store).

**Fold in while building (cheap, seeds the future):** record each manual selection as a
**labeled identity sample** (see §5) and stash per-subject **skeletal-proportion stats** in
the JSON.

---

## 4. Future: athlete memory (ReID)

Goal: after an athlete uploads a few clips, auto-detect which tracked subject is them.

**Mechanism**
1. A ReID model embeds a person crop → a vector; same person ⇒ similar vectors.
2. Build a per-athlete **gallery** of embeddings from clips where identity is known.
3. In a new clip, embed each subject, match against the gallery; auto-select the best match
   above a confidence threshold, else fall back to the heuristic + manual pick.

**Where ground-truth labels come from (no manual labeling effort)**
- **Single-person clips** (shadow/bag/drills) → unambiguously the athlete → free, high-confidence labels.
- **Every manual selection** in the picker → "this subject = me." The selector *is* the
  labeling UI → an active-learning flywheel (fewer manual picks over time).

**Reliability expectations (honest)**
- 1 solo clip → weak initial embedding.
- ~3–5 confirmed clips → auto-pick lands when conditions are similar (same gym/gear).
- Never 100% → always a confident default with one-tap correction.

**Domain edge (our advantage over generic ReID):** we have **pose**, so we can use
**clothing-invariant** identity signals — skeletal proportions (limb-length ratios, height,
shoulder width) and the **stance prior** (orthodox/southpaw, already detected). Fuse
appearance embedding + skeletal proportions + stance for robustness to outfit changes.

**Sequencing:** v2/v3. Prereqs: selector shipped, ReID model on GPU, consent plumbing.

---

## 5. Decisions

Legend: ✅ decided · 🟡 leaning · ⬜ open

| # | Decision | Status | Notes / lean |
|---|---|---|---|
| D1 | Selection must survive reprocessing | 🟡 | Don't store *only* the raw `tracker_id` (arbitrary per run). Store an **identity descriptor** (skeletal proportions now, embedding later) with the selection so we can re-match after a model/tracker upgrade. |
| D2 | Persist identity data for the **athlete only**, not bystanders/opponent | 🟡 | Privacy/legal. Keep others' strikes re-derivable from JSON, but don't store *appearance/identity* for non-consenting people. |
| D3 | Gate identity-memory behind explicit **biometric consent** | 🟡 | Add `users.biometric_consent_at`. Decide the consent model before storing the first embedding (BIPA-style — see CONTEXT.md). |
| D4 | Stamp `pipeline_version` on each clip/result | 🟡 | Know what model+tracker produced each clip; enables selective reprocessing. One column. |
| D5 | Separate "canonical subject (me)" from "current view" | 🟡 | A coach can view the opponent without overwriting the athlete's canonical selection. |
| D6 | Auto-pick is a confident default, never silent-and-final | 🟡 | Surface confidence ("We think Fighter 1 — confirm?"); always one-tap correctable. |
| D7 | Subject switch: instant metrics, **background** feedback regen | ⬜ | Today feedback regenerates synchronously (~seconds). Move to background so switching feels snappy. |
| D8 | Opponent data = latent asset, not noise | 🟡 | Keep re-derivable from JSON (already true) so the V3 opponent-scouting feature isn't foreclosed. Don't build scouting yet. |
| D9 | Only **high-confidence/user-confirmed** clips feed trend/longitudinal metrics | 🟡 | A wrong auto-pick would spike the athlete's progression with opponent data. Flag low-confidence clips. |
| D10 | Tier-gate heavy models / ReID | 🟡 | Heuristic for everyone; ReID + bigger trackers as a Pro/Elite perk (GPU cost). |
| D11 | Tracking library: migrate off `supervision` ByteTrack | 🟡 | Prefer **Ultralytics native tracking** (`model.track(persist=True, tracker="bytetrack.yaml"|"botsort.yaml")`) — removes the deprecation, drops the kp_index workaround, lets us toggle ByteTrack↔BoT-SORT. Then evaluate BoT-SORT/OC-SORT + ReID for clinch ID-swaps. |

---

## 6. Data-capture plan (start now, use later)

Already captured: `clips.selected_subject_id` per clip.

Add incrementally (cheap, forward-compatible):
- Per-subject **skeletal-proportion stats** in the keypoints JSON.
- A labeled **identity sample** row when a clip is processed/selected:
  `{ user_id, clip_id, subject_id, source: 'solo'|'manual'|'auto', skeletal_stats, embedding?(later), confidence }`.
- Mark **single-subject clips** as high-confidence identity samples.
- `pipeline_version` on the clip/result (D4).

This accumulates a per-athlete identity dataset from day one, so ReID becomes a switch to
flip rather than a cold start — *gated on consent (D3), athlete-only (D2)*.

---

## 7. Open questions

- Embedding model choice + where it runs (batched on GPU after tracking?).
- Gallery management: centroid vs. multi-look set; staleness/drift handling; how to recover
  from a bad manual label.
- Two near-identical fighters (same gym uniform) — is appearance + skeletal + stance enough,
  or do we accept manual selection for that case?
- Retention/deletion policy for raw videos + embeddings (ties to consent + reprocessing).
- Cross-clip identity surfaced to the user at all, or purely internal to auto-pick?

---

## 8. Iteration log

- **2026-06-07** — Initial draft. Captures shipped subject-selection pipeline, the
  near-term color-coded selector plan, the ReID vision, and decisions D1–D11.
