# Design: Opponent Scouting

> **Status:** Paused (foundation work first).
> **Why paused:** detection is unvalidated on opponent footage, stance detection is
> unreliable on unknown fighters, two-fighter tracking through clinches/occlusion is
> the unsolved big rock, and the highest-value scouting signal (telegraph detection)
> isn't built. Pose-model upgrade (RF-DETR) and identity/tracking work shift the
> answers to several of these. Revisit once that foundation lands.
> **Owner:** —  ·  **Last updated:** 2026-06-13
> **Related:** [product-strategy.md](product-strategy.md) §5, [pipeline-evolution.md](pipeline-evolution.md), [subject-identity-and-reid.md](subject-identity-and-reid.md)

---

## 1. Why this exists

Coaches do tape study before every fight: identify the opponent's weapons, habits,
openings, and tendencies, then build a tactical plan. Today this is hours of manual
work, often the night before a fight. From the product strategy review this is the
single clearest *"coach would pay for this"* feature — the existing pipeline
already produces ~80% of the inputs (strike detection, combos, predictability,
fatigue curves, guard tendencies), so the build is mostly aggregation + a prompt,
not new CV.

## 2. Scope (agreed)

### What it is

A **scouting report** for an opponent, generated from uploaded clips of them. The
report covers weapons, habits, openings, defensive tendencies, fatigue signature,
and 3 LLM-inferred tactical exploits — each tactic explicitly tied to a measured
tendency above (the *honesty guardrail*).

### Source material

- **Uploaded/downloaded clips only.** No YouTube URL ingestion. If we built URL
  ingestion *we* become the party doing the infringing download. Users who want to
  scout YouTube content screen-record and upload themselves.
- **MVP target: solo opponent footage** — bag work, shadowboxing, pad work. Single
  subject, detection closer to in-distribution, tracking trivial.
- **Two-person fight footage: gated follow-up.** Coaches want it most, but it
  depends on the unsolved two-fighter tracking work (see §6 blockers).

### Privacy boundary (firm)

Scouting outputs a tactical/behavioral *text* report — universally legal tape study.
The line we do not cross: **no persistent biometric identity gallery of the
opponent.** Opponent embeddings are not computed, not stored, and the opponent is
never added to anyone's gallery. The pipeline reuses everything we already produce
(pose keypoints, strike detections) but adds **zero** new biometric storage.
This is what keeps scouting on the right side of the same posture we adopted for
the athlete gallery (D2/D3): never persist non-consenting biometrics.

The future "opponent intelligence network" (cross-clip opponent recognition) is
*not* this feature and would need an upstream-consent model (gym/league
contracts), in the Hudl/Stats Perform mold.

### Out of scope for MVP

- Multi-clip opponent profiles aggregating several fights
- Telegraph detection on the opponent (depends on per-strike windowed features —
  the most differentiated scouting signal, but a separate feature build)
- Side-by-side evidence clips per claim
- Matchup / game-plan generator (crosses *the athlete's* profile with the scout —
  the natural next feature once the MVP lands and §6 blockers resolve)

---

## 3. Approach

### Opponent entity (decided)

**Reuse the existing `Session` as the opponent**, tagged with a scout flag. The
session's `label` carries the opponent's name; `opponent_context` carries
stance/style notes; clips inside the session are footage of that opponent.
Multi-clip opponent profiles (aggregating across sessions of the same opponent)
fall out naturally later without rework.

Alternatives considered and rejected: a first-class `Opponent` model (heavier
schema, premature for MVP), and one-report-per-clip (no aggregation path).

### Schema delta

Single boolean on sessions; migration `0005`, additive:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS is_scout boolean NOT NULL DEFAULT false;
```

### Upload / create flow

A "**Scout — opponent footage**" toggle in [UploadModal.jsx](../frontend/src/components/UploadModal.jsx)'s session-create
form. Modality (`session_type`: bag/pads/sparring/fight) is orthogonal: a scout
session can hold any clip type.

### Pipeline guard (the privacy line, in code)

In [modal_inference.py](../backend/modal_inference.py): when a clip's session is `is_scout`, **skip identity
capture and gallery matching entirely.** The opponent is not the consenting
user — no identity sample write, no gallery participation, no embedding stored.
One conditional around the two identity blocks does the work; everything else
(pose, strikes, predictability, etc.) runs identically.

### Aggregation

Reused from existing work in [feedback.py](../backend/services/feedback.py):
predictability, combos, fatigue curve, strike breakdown, guard-by-type, stance.

**New aggregation:** `_compute_openers(strikes, offsets)` — what the opponent leads
with in the first ~30s of each clip/round. Approximates "round opener" as
"clip/round-relative first 30s," which only fully holds when users clip per round;
documented limitation.

**New summary:** `build_scout_summary(session, clips, strikes, …)` wraps the
existing session aggregation, adds openers, tags itself as opponent analysis.

### Prompt design — the honesty guardrail

`build_scout_prompt()` produces a structured brief with **two clearly separated blocks**:

1. **What we measured (grounded facts)** — Weapons / Habits / Openings / Defensive
   tendencies / Fatigue signature. Every line cites a detected number, no LLM
   extrapolation. The same rules that govern athlete feedback ("only discuss
   metrics in the data block; never invent a number") apply harder here.
2. **How to exploit (LLM tactical inference)** — exactly 3 tactics. Each tactic
   **must reference a specific measured tendency from block 1** and explain the
   connection. The LLM is allowed to extrapolate tactics, but not facts.

The user chose "stats + LLM tactical inference" over "stats only" for richer
reports; this guardrail preserves the *trust* of stats-only while permitting the
*value* of inference. A skeptical coach can verify each exploit against the
measured fact it claims to derive from.

### Endpoint

The existing `GET /sessions/:id/feedback` branches on `session.is_scout`:
scout → scout prompt; otherwise → coaching prompt. Reuses the entire `llm_summary`
caching + dirty-hash mechanism — no new endpoint, no new cache layer. **The 2-clip
minimum is lifted for scout sessions** (a single opponent clip yields a report).

### Report view

In [SessionPage.jsx](../frontend/src/pages/SessionPage.jsx): when `session.is_scout`, the "Session analysis" panel
renders as a "**Scouting report**" — same fetch/cache mechanism, scout framing,
structured sections (Weapons / Habits / Openings / Fatigue / Exploits). The
existing 4-stat metric tiles and analytics tabs stay; they just describe the
opponent's measured behavior instead of the athlete's training.

---

## 4. Estimated effort

~2–3 focused sessions:
1. Backend: migration `0005`, `is_scout` plumbing, pipeline guard, openers
   aggregation, scout prompt, endpoint branching.
2. Frontend: upload toggle, scout report view, settings copy.
3. Tuning + validation pass (and pre-empting at least some of §6's blockers
   with quality hedging).

CV work: zero. This is product/aggregation/prompt work on a foundation
that's already shipped.

---

## 5. Quality hedging

Several blockers (§6) mean reports on rough footage can mislead. The MVP relies on
the **existing footage-quality scoring** (already drives LLM-output hedging for the
athlete coaching pipeline) to attach explicit confidence bands to scouting claims:

- `pose_quality_score` < threshold → "Low-confidence scouting — claims should be
  verified against the footage."
- `subject_confidence` < threshold (multi-person, identity unclear) → call out that
  the opponent attribution may be wrong.
- Sparse data (few strikes, short clip) → "Insufficient sample for tendency
  claims" rather than reporting a tendency.

Reports on rough footage **should say they're low-confidence rather than bluff.**

---

## 6. Blockers — the 20% that paused this

(See conversation 2026-06-13. These are why we're not building yet.)

1. **Detection is unvalidated on opponent footage.** Every threshold and gate was
   tuned on the user's footage: one athlete, one set of camera angles, one gym.
   Opponent clips are out-of-distribution. There's no scouting-specific golden set,
   so the MVP would inherit detection's metrics *on faith.* **Need:** a small scout
   golden corpus (5–10 labeled opponent clips from different sources) before
   thresholds are trusted on this domain.

2. **Stance detection unreliable on unknown fighters.** Stance mislabels invert
   jab/cross and lead/rear naming — the *exact* tendencies scouting reports on.
   This was found to fail on the user's own clips (front-camera mirroring bug);
   for an unknown fighter with no priors it's worse. **Mitigation:** bias the
   report toward stance-invariant signal (combo sequences, straight-vs-hook-vs-kick
   mix, volume, fatigue decay, guard) rather than jab-vs-cross granularity.
   **Real fix:** stance-detection rework (mirror-robust, possibly side-confirming
   via multiple clips of the same opponent).

3. **Two-fighter fight footage is the unsolved big rock.** Solo opponent footage
   is single-subject and clean. Coaches mostly want fight footage — two people,
   clinches, occlusion. The within-clip track-repair work helped (drift fixture
   solved, fragmentation halved), but robust opponent isolation through a full
   fight is unproven. **Need:** the 6–12-month two-fighter tracking work (roadmap
   item 3 / signature feature #3), which a better pose model (RF-DETR) may
   materially help with.

4. **Highest-value scouting signal isn't built.** Telegraph detection ("they drop
   the lead hand before the right") is the most differentiated scouting line in
   the product strategy. Without it, the MVP report leans on combos +
   predictability + fatigue — useful, but missing its hero feature. **Need:**
   per-strike windowed-feature mining (separate feature build).

5. **Round segmentation is approximate.** "What they lead with each round" assumes
   one round per clip. A continuous fight video has no round detection. **Fix:**
   round-boundary detection (audio cues / sustained low-action gaps), or require
   per-round clip upload at MVP.

---

## 7. Build-readiness signals

Scouting should be revisited when **at least three of these** hold:

- [ ] Pose-model upgrade (RF-DETR or similar) shipped, with detection F1 on
      out-of-distribution footage measured and acceptable
- [ ] Two-fighter tracking through a full sparring/fight clip demonstrates
      stable opponent isolation
- [ ] Stance detection mirror-bug fixed; confidence reported per clip
- [ ] Scout-specific golden corpus exists (≥5 labeled opponent clips)
- [ ] Telegraph detection v1 ships
- [ ] Round segmentation works (or product UX requires per-round upload)

---

## 8. Open questions for the next iteration

- Should multi-clip opponent profiles be in v1, or a follow-up? (Bias: follow-up.)
- Should the scouting report be Pro/Elite gated like trend feedback, or free?
  (Cost ≈ existing session feedback; not heavy.)
- Where does the matchup/game-plan generator live — as a feature *of* scout
  sessions (cross with the athlete's profile in-place), or its own surface?
- Bring-your-own-opponent flow: do we ever let coaches share scout sessions with
  athletes they coach?
