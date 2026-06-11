# Southpaw — Product Innovation & Advanced Analytics Strategy

## Context

Southpaw today: pose estimation (YOLOv8 n/s/m via Modal), multi-person tracking + subject selection, strike detection/classification v2 (with extension curves, retraction, hip-rotation proxy, limb velocity, torso normalization), combo detection, head movement scoring, stance detection, guard discipline, fatigue curves, session aggregation, trend summaries, and a DeepSeek-backed feedback pipeline at session/clip/trend level.

This document identifies what to build next, ranked by athlete outcomes, coach usefulness, retention, and differentiation — not novelty. Key strategic read: **the codebase is closer to several "future" features than the roadmap implies.** Per-strike extension/retraction curves and combo sequences already exist in the DB; pattern mining, guard-return timing, and scouting reports are mostly aggregation + prompt work, not new CV.

**Three theses that shape everything below:**

1. **The coach is the customer; the athlete is the user.** Solo-athlete vanity metrics churn. Tools that save a coach 30 minutes per athlete per week become the gym's operating system. Hudl built a 9-figure business on team-sports film workflow; combat sports has no Hudl.
2. **Predictability is the killer insight class.** Coaches watch film to answer one question: "what does this fighter do habitually?" Pattern mining over already-detected strike sequences answers it cheaply, works on solo footage, and applies identically to self-analysis and opponent scouting.
3. **Honesty is the moat.** 2D single-camera pose cannot measure punch force or true speed. Every metric shipped must be defensible to a skeptical coach. Confidence-gated, proxy-labeled metrics ("guard return time") beat pseudo-science ("punch power: 87").

---

# 1. Technique Analytics

**Guard return speed (per-strike hand recovery) — S Tier**
- Why: "Bring your hand back" is the single most-repeated correction in every boxing gym on earth. The lazy right hand after the jab loses fights. Nobody quantifies it.
- Who: Every athlete, every striking sport; coaches get an objective lever for their most common cue.
- Data: Existing keypoint traces; `_retraction()` and `_extension_curve()` in `strike_classifier.py` already compute most of this. Need: time from peak extension → wrist back within threshold of chin height, stored per strike.
- Difficulty: **Low** (1–2 weeks; extends existing per-strike computation).
- Differentiation: High — concrete, trainable, trendable. "Your right-hand return after the jab: 0.74s, gym median 0.55s, down from 0.81s last month."
- MVP: Per-strike `return_ms` column + session distribution + worst-offender strike type called out in feedback.
- Advanced: Conditioned analysis (return speed by strike type, by round, by fatigue tercile); alert when fatigue degrades it.

**Telegraph detection (pre-strike tells) — S Tier**
- Why: This is literally what opponents' coaches look for in film study. "You drop your lead hand 300ms before every right cross" is a fight-changing insight, and it works on bag/shadow footage.
- Who: Competitive athletes and their coaches; doubles as the engine for opponent scouting (§5).
- Data: Keypoint windows 300–500ms before each detected strike. Mine for precursors (wrist drop, elbow flare, shoulder dip, hip pre-shift, rear-heel lift) that precede >70% of one strike type but rarely occur otherwise (information-gain style).
- Difficulty: **Medium** (heuristic v1 feasible solo; needs per-strike windowed features + frequency analysis).
- Differentiation: Very high. No consumer product does this. Instantly credible to coaches.
- MVP: 3–4 hand-engineered tells (lead-hand drop, rear-hand drop, shoulder load) with occurrence rates per strike type.
- Advanced: Learned precursor discovery; severity = how early and how visible the tell is; side-by-side clip evidence montage.

**Kinetic chain / "arm punching" detection — A Tier**
- Why: Power comes from sequencing: hips initiate, shoulders follow, fist last. Punches thrown with no hip involvement ("arm punches") are the #2 gym correction. `_hip_rotation()` already exists as a proxy.
- Who: Beginners/intermediates most; coaches use it to triage who needs mechanics work.
- Data: Existing hip-rotation proxy + shoulder-line angle; measure timing offset between hip angular velocity peak and wrist velocity peak per strike. Side-view footage works well; front-view is degraded — gate by camera angle via pose quality.
- Difficulty: Medium. Differentiation: High.
- MVP: Binary "hip engagement" flag per power strike + % of arm-punches per session.
- Advanced: Sequencing-quality score (hip→shoulder→fist lag ordering), per-strike-type breakdown, fatigue interaction.

**Balance / over-extension — A Tier**
- Why: Reaching (COM beyond lead foot) creates knockdowns and counters. Detectable: mid-hip x-position vs ankle base during strike apex.
- Data: Existing keypoints (ankles + hips). Difficulty: Low-medium. Differentiation: Medium-high.
- MVP: Over-extension flag per strike, % per session. Advanced: balance-under-pressure in sparring; recovery time after over-extension.

**Post-strike head position off centerline — A Tier**
- Why: "Don't admire your work." Head static on centerline after a combo = counter magnet. Nose displacement in the 1s post-combo vs idle baseline is trivial to compute and maps to the #3 most-repeated coaching cue.
- Difficulty: **Low**. Differentiation: High for effort. MVP: "punch-and-stay rate" per session. Advanced: tie to actually-eaten counters in sparring footage.

**Kick chamber & hip turnover quality (Muay Thai) — B Tier**
- Why: Round-kick power = hip turnover; chamber height differentiates teep/round/question-mark. MT users are underserved.
- Data: Knee/hip/ankle keypoints; COCO-17 lacks foot detail (ankle only) — adequate for chamber height + turnover proxy, not foot position.
- Difficulty: Medium. MVP: chamber height + hip rotation per kick. Advanced: needs better pose model (RTMPose wholebody) for foot strikes/balance leg.

**Stance geometry drift (width/length over rounds) — B Tier**
- Fatigue narrows or squares stances. Easy from ankle keypoints; useful as a fatigue input more than a headline metric. Fold into fatigue curve rather than ship standalone.

**Pivot quality / foot placement — C Tier (for now)**
- Ankle-only keypoints + 30fps + variable camera angles make this unreliable. Revisit after pose-model upgrade. Shipping a flaky version damages trust in everything else.

---

# 2. Footwork Analytics

**Directional bias profile — A Tier**
- Why: "He always circles left" — into or away from power — is a classic exploitable habit and a classic scouting note. Computable without ring geometry: ankle-midpoint displacement vectors relative to facing direction.
- Who: Athletes (self-awareness), coaches, and scouting (§5) identically.
- Data: Existing tracking; no homography needed for relative bias. Difficulty: **Low-medium**.
- MVP: % time circling left vs right vs linear retreat vs forward, per session. Advanced: bias conditioned on context (after combos, when pressured, by round).

**Strike-while-moving ratio ("planted feet" detection) — A Tier**
- Why: Beginners plant before punching (telegraph + immobile target). Elite strikers punch off movement. Ratio of strikes thrown with ankle velocity ≈ 0 vs in motion is simple and coachable.
- Difficulty: **Low**. Differentiation: High for effort. MVP: planted-strike % per session, trended.

**Movement heatmap & ring positioning — B Tier (A with sparring mode)**
- Why: Center control / ropes time is real ring-generalship data, but needs floor-plane homography (ring ropes/canvas lines or cage fence detection) — a meaningful CV project, and most training footage is open gym floor with no reference geometry.
- MVP: skip homography; relative "ground covered" + movement tempo per round. Advanced: true ring-coordinate heatmaps for fight/sparring footage where ring is visible; corner-escape detection.

**In-and-out entry/exit speed — B Tier**
- Valuable but only meaningful in two-person footage (range is defined by an opponent). Build inside sparring mode (§4), not standalone.

**Stance-switch frequency/timing — C Tier**
- Easy to compute (stance detection exists), low coaching value standalone; include as a scouting feature flag (§5) rather than an athlete metric.

---

# 3. Defensive Analytics

Defense is the underserved half of the market, and Southpaw already tracks guard. The leverage is conditioning defensive metrics on offensive events.

**Defensive responsibility score (guard discipline during/after offense) — S Tier**
- Why: Guard-while-idle is easy; what gets fighters hurt is guard *during their own offense* (non-punching hand drops while punching) and *immediately after* (lazy return + static head). Combining existing guard_dropped + new return-speed + post-strike head movement into one conditioned score is the defensive metric coaches actually mean when they say "defensive responsibility."
- Who: Every sparring athlete; coaches get a single trendable number with drill-level breakdowns.
- Data: All inputs exist or are §1 items. Difficulty: **Low-medium** (composition + weighting, not new CV).
- Differentiation: Very high — this is a coach's-eye metric, not a fitness-app metric.
- MVP: 0–100 composite from (non-striking-hand guard during strikes, return time, post-combo head movement), with the three components shown.
- Advanced: Calibrate weights against actually-absorbed strikes in sparring footage; per-strike-type vulnerability map ("your left hook leaves the right side of your jaw exposed for 0.4s").

**Exposure windows — A Tier**
- Why: Duration-weighted openness beats counting guard drops. A 2s hands-down window is worse than five 0.2s dips.
- Data: Existing guard tracking → continuous exposure timeline instead of boolean per strike. Difficulty: Low.
- MVP: total exposure seconds/round + longest window + when in round they cluster. Advanced (sparring): exposure conditioned on being in opponent's range — the only exposure that matters.

**Slip/roll/duck classification — A Tier**
- Why: Head-movement *variety* and *appropriateness* matter more than raw movement std (current metric). Classifying evasive actions enables "you only ever slip right" — a predictability insight (§5 applies to defense too).
- Data: Head + shoulder trajectories; classifiable with heuristics (lateral vs vertical vs rotational displacement signatures). Difficulty: Medium.
- MVP: slip-left/slip-right/duck/roll counts per session + variety entropy. Advanced (sparring): reaction latency to incoming strikes; defensive-reaction success rate.

**Defensive predictability — A Tier (S inside scouting)**
- Same n-gram/entropy machinery as offense (§5) applied to defensive reactions: "responds to the jab with a right slip 84% of the time" = a counter waiting to happen. Near-free once slip classification exists.

---

# 4. Sparring-Specific Metrics (two-fighter tracking)

This is the biggest single unlock and the hardest. Multi-person tracking exists; the work is robust identity persistence through clinches/occlusion (ByteTrack/BoT-SORT + re-ID embedding) and interaction modeling. Everything here is impossible for bag-work-only competitors — it's the moat chapter.

**Exchange detection + initiative profile — S Tier**
- Why: Sparring review today = coach scrubbing 15 minutes of video. Auto-segmenting into exchanges ("23 exchanges; you initiated 7, landed last in 9") turns review into minutes and produces fight-IQ metrics no solo product can.
- Data: Both fighters' poses + inter-fighter distance; exchange = window where distance < punching range and ≥1 strike. Difficulty: **High** (tracking robustness is the long pole).
- MVP: exchange count, initiation %, strikes thrown per exchange per fighter, exchange timeline on the player.
- Advanced: exchange outcomes via **head-snap proxy** — a strike followed by sharp recipient-head velocity spike ≈ clean landed shot (honest label: "estimated"). Last-clean-strike rate, counter rate (strikes within 600ms of opponent's strike).

**Pressure & ring generalship index — A Tier**
- Why: "Who is walking whom down" is visible in tracking data without ring geometry: share of time moving forward while opponent retreats, distance-closing initiations.
- MVP: forward-pressure %, backward-movement share, average separation. Advanced: cut-off effectiveness (lateral mirroring when opponent circles), with ring geometry where visible.

**Range profile — A Tier**
- Why: Preferred engagement distance (normalized by fighter heights) defines style. "You land at long range but get hit entering mid-range without a jab" is elite-analyst output.
- MVP: inter-fighter distance histogram + distance-at-which-strikes-happen. Advanced: entry analysis — what you do (or don't throw) while closing.

**Tempo control — B Tier**
- Exchange frequency over time and who resets the pace. Derivative of exchange detection; ship after it.

---

# 5. Opponent Scouting

The "I would pay for this" category. Strategic insight: **scouting is the existing pipeline pointed at different footage + a different report.** Strike detection, combos, stance, guard, fatigue curves all transfer. The deltas are an "opponent" entity, pattern mining, and a report format.

**Automated scouting report — S Tier**
- Why: Coaches spend hours doing exactly this manually before every fight. A report containing: top-5 combinations with frequencies (n-grams over detected strike sequences — `_aggregate_combos` is the seed), opening tendencies (first 30s of each round), post-event habits ("after getting touched to the body he resets straight back"), stance-switch triggers, defensive reaction profile, and fatigue signature (round-over-round output slope + guard-height decay) — that's a fight-week deliverable coaches currently pay analysts for or do at 1am.
- Who: Coaches and competitive athletes; also the clearest B2B wedge (gyms, promotions, regional teams).
- Data: Uploaded opponent footage (fights are usually well-shot, which *helps* CV quality vs gym footage). Difficulty: **Medium** — mostly aggregation + prompt engineering over existing detections; two-person fight footage benefits from §4 but a single-subject v1 (track only the opponent) works today.
- Differentiation: Extreme. This is the feature that makes a coach say the quote in the brief.
- MVP: "Scout" upload type → existing pipeline on opponent as subject → LLM scouting brief from a dedicated prompt template in `feedback.py`, structured as: weapons / habits / openings / fatigue / 3 exploit suggestions.
- Advanced: multi-video opponent profiles (aggregate 3–5 fights), telegraph detection (§1) on the opponent, side-by-side evidence clips per claim, predictability index per situation.

**Predictability index (works on self AND opponents) — S Tier**
- Why: Conditional entropy over strike sequences: given the last two strikes, how guessable is the next? Plus situation-conditioned tendencies (after opponent's jab, when backed up, first 15s of round). For the athlete it's "you're throwing the same three combos"; for scouting it's the exploit map. One engine, two products.
- Data: **Already in the database** — detected strike sequences with timestamps. Difficulty: **Low** (statistics + a UI panel). The single best value/effort ratio in this document.
- MVP: top combos with frequencies + 0–100 predictability score per session, in SessionPage and feedback prompt. Advanced: context-conditioned tendencies, cross-session habit persistence, "most exploitable pattern" callout.

---

# 6. Game Planning

**Matchup brief generator — A Tier**
- Why: Once both your profile (tendencies, §5-on-self) and the opponent's scout report exist, the synthesis — "his most-thrown weapon walks into your best counter; here are 3 tactics and the drills to rep them" — is exactly what LLMs do well *when grounded in detected stats*.
- Who: Fight-camp athletes and coaches. Data: two Southpaw profiles. Difficulty: Medium (the CV is done; the work is prompt design + guardrails so every tactical claim cites a detected stat — ungrounded tactics would destroy credibility).
- Differentiation: Very high; nobody connects scouting → plan → training assignments.
- MVP: 1-page brief: their weapons vs your defensive profile, their openings vs your weapons, 3 tactics + 3 drill assignments. Coach edits/approves before athlete sees it (this also generates training data, §13).
- Advanced: camp-long plan integration — game-plan adherence tracking in subsequent sparring sessions ("the plan says lead-hand body work: it appeared in 4% of your output this week").

---

# 7. Longitudinal Progress Tracking

**Standardized benchmark protocol — A Tier (sleeper pick)**
- Why: Comparing random sessions is apples-to-oranges (different drills, partners, energy). Sports science 101: standardize the test, vary the training. A monthly fixed protocol — e.g., 3×3min shadowbox: round 1 free, round 2 defense-only, round 3 max output, fixed camera angle — makes trend lines actually mean something. Mostly product work, zero new CV.
- Who: Athletes get honest progress; coaches get comparable data across their roster; Southpaw gets clean, comparable data for benchmarking (§12) — a data-quality flywheel.
- Difficulty: **Low** (a guided recording flow + a "benchmark" session type). Differentiation: High — it reframes Southpaw from "we measure whatever you upload" to "we run your athletic testing."
- MVP: benchmark session type + protocol instructions + dedicated comparison view (this benchmark vs last 3). Advanced: sport-specific protocols, gym-administered testing days, percentile context once N grows.

**Signal-vs-noise honest trending — A Tier**
- Why: Current trend analysis will happily report noise as progress. Showing confidence bands (session-to-session variance per metric) and only flagging changes that clear it builds the trust everything else depends on. Metrics differ wildly in stability — punch volume is noisy, guard-return time is stable.
- Difficulty: Low-medium (statistics over existing `build_trend_summary` data). MVP: trend arrows only when change > variance band; "needs more sessions" otherwise. Advanced: per-metric reliability coefficients learned from corpus.

**Skill-dimension velocity — B Tier**
- Roll metrics into 4–5 dimensions (output, technique quality, defense, footwork, conditioning) with rate-of-change per camp. Good summary layer once components are trustworthy; don't lead with it.

---

# 8. Fight Camp Intelligence

**Camp dashboard — A Tier**
- Why: An 8-week camp with every session logged enables: weekly volume (strikes, session minutes), intensity mix (% spar/pads/bag — session types exist), technical-focus distribution, fatigue-onset trend (when in sessions the fatigue curve inflects — earlier onset across a week = accumulating fatigue), and guard-discipline-late-in-session decay as an overtraining proxy.
- Who: Coaches managing camps; serious athletes self-managing. Data: existing session aggregates + a "camp" entity (start date, fight date, focus goals). Difficulty: **Medium** (mostly aggregation + UI; camp entity is a small schema addition).
- Differentiation: High — this is the retention engine: 8 weeks of daily uploads is a habit, and camp history is unexportable lock-in.
- MVP: camp entity + weekly rollup view + taper visibility (volume should fall in fight week — flag if it isn't).
- Advanced: readiness composite with wearables (§9); camp retrospectives ("what your last camp looked like at week 6"); technical-focus drift alerts vs camp goals.

**Focus-drift alerts — B Tier**
- "Camp goal: fix right-hand return. It improved week 1–2, regressed since, and pad sessions stopped targeting it." Needs camp goals + per-metric tracking; cheap once camp entity exists.

---

# 9. Training Load & Recovery (Wearables)

Be careful here: WHOOP/Oura already own recovery scores. Don't compete — **fuse**. The unique asset is technical data; the composite no one else can build is *technique under physiological load*.

**Technical durability score (technique × HR) — A Tier**
- Why: Everyone's technique degrades when gassed; *at what intensity* it degrades is the trainable, fight-relevant number. Guard height / return speed / strike-while-moving plotted against HR zones answers "does your defense survive zone 4?"
- Data: HR stream synced to video timeline. Start with Apple Health export / HealthKit (lowest friction), then WHOOP/Garmin APIs. Sync via session timestamps. Difficulty: Medium (integration plumbing more than science).
- MVP: HR overlay on session timeline + "technique by HR zone" table. Advanced: durability trend across camp (degradation threshold moving up = real conditioning progress that a treadmill test can't show).

**Round-recovery conditioning trend — B Tier**
- HR recovery in rest minutes between detected rounds, tracked across camp. Simple, meaningful, fully derivative of the HR sync above.

**Readiness-adjusted session suggestions — C Tier**
- "WHOOP says red, go light" — crowded, undefensible, and coaches resent apps prescribing. Skip.

---

# 10. Coach Workflow Features

**Smart review timeline — S Tier**
- Why: The #1 coach complaint about film is time. Event markers on the player timeline — every strike/combo, guard drops, exposure windows, fatigue inflection, best/worst sequences — with one-click jump turns a 60-minute session into a 5-minute review. All events already exist in the DB; this is frontend + event API.
- Who: Coaches first, athletes equally. Difficulty: **Low-medium** (PlayerPage work; no new CV). Differentiation: High — it's the difference between "analysis tool" and "review tool I use daily."
- MVP: marker strip on PlayerPage with event-type filters + jump. Advanced: auto-generated highlight/lowlight reels ("worst 5 defensive moments this week"), shareable timestamped coach comments.

**Coach roster dashboard with red flags — A Tier**
- Why: A coach with 12 athletes can't read 12 dashboards. One screen: roster, who trained, and surfaced exceptions ("Maya's guard discipline −20% over 2 weeks"; "Deon's volume down 40%"). Exception-based, not data-browsing.
- Data: existing per-athlete aggregates + coach-athlete relationship (Clerk orgs fit naturally). Difficulty: Medium (the relationship/permission model is the real work). MVP: roster + last-session summaries + 2–3 rule-based flags. Advanced: weekly digest email, configurable thresholds.

**Voice review → structured feedback — A Tier**
- Why: Coaches will talk for ten minutes but won't type ten words. Coach records voice notes while scrubbing (or over the video); Whisper transcribes; LLM converts to timestamped, structured athlete feedback + drill assignments. **Dual value: it's also the training-data collection mechanism for §13** — every voice review is a (video context → elite coaching language) pair.
- Difficulty: Low-medium (Whisper + existing LLM plumbing + a record button). Differentiation: High, and compounding.
- MVP: voice note per clip → transcript → structured summary athlete sees. Advanced: timestamp-aligned comments, auto-drill-assignment extraction, review templates learned per coach.

**Side-by-side synced comparison — B Tier**
- Before/after or athlete-vs-teammate, synced playback. Useful, not urgent; pure frontend.

---

# 11. Athlete Workflow Features

**Weekly focus loop — A Tier (S for retention)**
- Why: Dashboard soup kills engagement; one tracked correction at a time mirrors how good coaches actually work. Coach (or AI, coach-approved) sets ONE focus — "right-hand return" — and every session leads with exactly that metric: "0.81s → 0.68s. Three sessions in a row improving." Clear loop: train → upload → see the needle move.
- Data: all existing; needs a `focus` field + feedback-prompt priority. Difficulty: **Low**. Differentiation: High — it converts metrics into a learning loop, which is the actual product promise.
- MVP: focus selection + headline placement in session feedback + small trend sparkline. Advanced: auto-suggested next focus when current one plateaus at a good level; drill suggestions per focus.

**Personal records on meaningful metrics — B Tier**
- Best predictability score, best defensive-responsibility session, longest guard-discipline streak under fatigue. Fine as seasoning; never the meal.

**Streaks/challenges/badges — C Tier**
- The brief says no gimmicks; agreed. Serious athletes are retained by evidence of progress, not confetti.

---

# 12. Benchmarking & Rankings

Honest take: **global percentiles are a year-2 feature** — they need thousands of comparable sessions, and uncontrolled footage isn't comparable. Sequence matters:

1. **Vs. past self — A Tier, now.** The benchmark protocol (§7) makes this rigorous. This is 90% of the motivational value with 0% of the cold-start problem.
2. **Vs. gym — B Tier, when a gym has 5+ athletes.** "Gym median guard-return: 0.6s" is meaningful context and a natural coach conversation. Falls out of the roster dashboard.
3. **Elite reference ranges — B Tier, opportunistic.** Run the pipeline on public fight footage of elite fighters; publish *metric ranges* (not footage): "elite jab-return: 0.35–0.45s." Legally cleaner than a footage library, and it calibrates every athlete-facing number. Also makes great marketing content.
4. **Global percentiles/leaderboards — C Tier.** Cold start, sandbagging, footage-quality confounds. Revisit at scale.

---

# 13. AI Coaching Evolution

The long-term moat is a dataset nobody else is positioned to collect: **(pose-derived technical context → elite coach feedback → athlete outcome) triples.**

- **Phase 1 (now): structured grounding.** Already done — feedback prompts are metric-grounded. Tighten: every AI claim must cite a stat; confidence-gate low-quality data (pose-quality gating exists).
- **Phase 2 (6–12 mo): retrieval over the coach corpus.** Embed every coach review (typed and voice, §10) with its session-metric context. When generating feedback for a similar situation, retrieve and ground in real coach phrasing. The AI starts sounding like *their* coach, and quality scales with corpus size — a compounding advantage from day one of voice-review collection.
- **Phase 3 (12+ mo): preference training.** Coach edits/approvals of AI drafts ("AI drafts, coach approves" workflow in §6/§10) are natural preference pairs (DPO-style). Fine-tune or heavily steer on (metrics → approved coaching) pairs.
- **Phase 4 (long-term): outcome grounding.** With competition results and sparring outcomes logged, ask what actually predicts winning — which metrics matter, which corrections move outcomes. That's a research asset no incumbent (fitness apps) or fast-follower (LLM wrappers) can replicate without the longitudinal triple-linked data.
- **Strategic implication for today:** structure every coach interaction (reviews, edits, approvals) as labeled data from the very first coach user. The product features that collect it (§10 voice review, §6 plan approval) must ship before the model work matters.

---

# 14. Signature Five

1. **Automated opponent scouting reports** — The clearest "shut up and take my money" for the coach buyer; reuses ~80% of the existing pipeline; no consumer competitor exists. User value: fight-week edge. Coach value: hours saved + analyst-grade output. Difficulty: medium. Defensibility: grows with multi-fight opponent profiles and the pattern-mining engine.
2. **Predictability & telegraph profiling** — Works today on solo footage; one engine serves self-analysis and scouting; instantly understood by every fighter ("you're predictable" is universal gym language). Difficulty: low (patterns) to medium (telegraphs). Defensibility: medium alone, high as the engine inside scouting.
3. **Two-fighter sparring intelligence** — Exchanges, initiative, pressure, range, head-snap landed estimates. Hardest build, biggest moat: impossible for bag-tracker competitors, and it makes sparring — the most important training footage — the most valuable upload type. Difficulty: high. Defensibility: very high.
4. **Smart review timeline + coach workflow suite** — Turns Southpaw from analysis tool into the daily film-room. Coaches become the distribution channel (one coach brings 10–30 athletes). Difficulty: low-medium. Defensibility: workflow lock-in + the §13 data flywheel rides on it.
5. **Fight camp intelligence** — Longitudinal camp dashboards + benchmark protocol + readiness context. The retention engine and the source of unexportable history. Difficulty: medium. Defensibility: compounds with every camp logged.

Why these five: each one is either impossible for adjacent competitors (3, 5), a direct coach-wallet feature (1, 4), or a near-free unlock of existing data (2) — and together they form a loop: athletes upload (5) → patterns found (2) → coach reviews efficiently (4) → opponents scouted (1) → sparring validates (3) → outcomes feed the AI (§13).

---

# 15. Roadmap

## Ship in next 3 months (solo founder, mostly extends existing code)

1. **Predictability profile** — n-grams + entropy over existing strike/combo data (`_aggregate_combos` is the seed); SessionPage panel + feedback-prompt section. ~1 wk. Highest value/effort in the entire document.
2. **Per-strike defensive micro-metrics** — guard-return time (extend `_retraction`/`_extension_curve`), post-combo head movement, strike-while-planted flag. New columns on strikes + aggregation. ~2 wks.
3. **Smart timeline on PlayerPage** — event markers (strikes, combos, guard drops, fatigue inflection) with jump + filters; events already exist. ~1 wk.
4. **Scouting MVP** — "scout" upload/session type, opponent-as-subject through the existing pipeline, dedicated scouting prompt template in `feedback.py` (weapons / habits / openings / fatigue / 3 exploits). ~2 wks.
5. **Weekly focus loop** — focus field + feedback-prompt priority + sparkline. ~1 wk.
6. **Defensive responsibility composite** — assembled from item 2's components. ~1 wk.
7. *(Stretch)* **Telegraph detection v1** — 3 heuristic tells with occurrence rates.

Sequencing logic: items 1–6 ship visible, coach-credible value with near-zero new CV risk, and items 1+4 together create the first "I would pay for this" demo.

## Ship in 6–12 months

- **Two-fighter sparring mode** — robust dual-identity tracking (ByteTrack/BoT-SORT + re-ID), exchange detection, initiative/pressure/range profiles, head-snap landed estimates. The big rock; everything else this period is parallelizable around it.
- **Coach accounts & roster dashboard** — Clerk orgs for coach-athlete relationships, exception-based red flags, weekly digest. Unlocks B2B motion.
- **Voice review pipeline** — Whisper + structuring; begins the §13 data flywheel. Cheap; ship early in this window.
- **Camp entity + camp dashboard** — weekly rollups, taper visibility, fatigue-onset trend.
- **Benchmark protocol** — guided monthly test + comparison view.
- **Pose-model upgrade** — RTMPose/wholebody (feet + better hands) behind the existing Modal inference seam; unlocks kicking metrics and pivot work. (YOLOv8 s/m weights already in repo; the seam exists in `modal_inference.py`.)
- **HealthKit import + HR-synced timeline** — first wearable, lowest friction; technical-durability v1.

## Long-term vision (category-defining at scale)

- **Full sparring intelligence** — exchange outcomes, counter analysis, defensive-reaction success; sparring becomes objectively reviewable the way game film is in team sports.
- **Game-plan generator with adherence tracking** — scout report × self profile → coach-approved plan → measured in subsequent sparring. Closes the loop from analysis to strategy to verified execution.
- **Coach-corpus-trained feedback model** — retrieval, then preference-tuned; the AI coach that learned from thousands of real coach reviews tied to real footage and real outcomes. The defensible asset.
- **Opponent intelligence network** — opt-in shared scouting profiles of regional competitors built from public footage; network effects make Southpaw more valuable with every gym that joins ("Hudl + FightMetric for combat sports").
- **Elite reference ranges + outcome research** — published benchmarks from pro footage analysis; eventually, the dataset that answers which technical metrics actually predict winning.

## Explicitly not building (and why)

- **Punch power/force scores** — unmeasurable from 2D pose; pseudo-science that poisons trust in everything honest.
- **Speed in mph/kmh** — camera-distance-dependent; relative torso-normalized velocity (already computed) is the honest version.
- **Leaderboards/global rankings early** — cold start + footage confounds (§12).
- **Recovery scores** — WHOOP's lane; fuse, don't compete (§9).
- **Rep counting as a headline** — commodity; every fitness app does it.
