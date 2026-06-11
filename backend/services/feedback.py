"""
LLM feedback pipeline.

build_session_summary() — aggregates strike rows into a structured dict
build_feedback_prompt() — turns the summary into a system + user prompt
generate_feedback()     — calls DeepSeek and returns the coaching text
compute_session_hash()  — MD5 of summary dict, used for cache invalidation
"""

import hashlib
import json
import math

from openai import AsyncOpenAI, OpenAI
from core.config import settings


# LLM model per subscription tier — same DeepSeek API, different model
LLM_MODELS = {
    "free":  "deepseek-chat",      # DeepSeek V3 — fast, cost-effective
    "pro":   "deepseek-chat",      # DeepSeek V3
    "elite": "deepseek-reasoner",  # DeepSeek R1 — chain-of-thought reasoning
}

SPORT_LABELS = {
    "boxing":    "Boxing",
    "muay_thai": "Muay Thai",
    "mma":       "MMA",
}

SESSION_TYPE_LABELS = {
    "sparring": "sparring",
    "bag":      "bag work",
    "pads":     "pad work",
    "shadow":   "shadow boxing",
}

# Sport-specific coaching context injected into the system prompt.
# Each sport has different technique standards — what's wrong in boxing
# may be correct in Muay Thai (e.g. wide stance, dropping hands before kicks).
SPORT_CONTEXT = {
    "boxing": (
        "In boxing, guard discipline is critical — hands must return to guard position "
        "after every punch. A wide stance is incorrect. Punch extension matters: "
        "a fully committed jab or cross should reach near-full shoulder-to-wrist distance."
    ),
    "muay_thai": (
        "In Muay Thai, the stance is wider than boxing. Dropping both hands momentarily "
        "before a kick chambering is acceptable and common. Clinch work and elbow strikes "
        "complement punches and kicks. Guard standards differ from boxing."
    ),
    "mma": (
        "In MMA, technique varies with range and context. Both punching extension and "
        "guard discipline matter in striking range, but lowering hands to set up takedowns "
        "is situationally appropriate."
    ),
}


# ---------------------------------------------------------------------------
# Combo detection
# ---------------------------------------------------------------------------

COMBO_WINDOW_SECONDS = 1.5
MIN_COMBO_LENGTH = 2
MAX_COMBO_LENGTH = 6  # longer chains are continuous output, not one combo


def _strikes_by_job(strikes) -> list[list]:
    """Group strikes by job (one job = one clip) and sort each group by time.
    timestamp_seconds is clip-relative, so sequences must never span clips."""
    groups: dict = {}
    for s in strikes:
        groups.setdefault(s.job_id, []).append(s)
    return [sorted(g, key=lambda s: s.timestamp_seconds) for g in groups.values()]


def _split_chain(chain: list) -> list[list]:
    """Split an over-long chain at its largest internal gap, recursively, until
    every segment fits MAX_COMBO_LENGTH. At high output (every gap under the
    combo window) the plain window check chains a whole round into one
    47-strike 'combo'; the relatively largest pauses are the natural combo
    boundaries."""
    if len(chain) <= MAX_COMBO_LENGTH:
        return [chain]
    k = max(range(len(chain) - 1),
            key=lambda i: chain[i + 1].timestamp_seconds - chain[i].timestamp_seconds)
    return _split_chain(chain[:k + 1]) + _split_chain(chain[k + 1:])


def _detect_combos(strikes) -> list[list]:
    """Group strikes into combos — consecutive strikes within COMBO_WINDOW_SECONDS,
    capped at MAX_COMBO_LENGTH by splitting at the largest gaps."""
    combos = []

    def _flush(chain):
        for segment in _split_chain(chain):
            if len(segment) >= MIN_COMBO_LENGTH:
                combos.append(segment)

    for group in _strikes_by_job(strikes):
        current = [group[0]]
        for strike in group[1:]:
            if strike.timestamp_seconds - current[-1].timestamp_seconds <= COMBO_WINDOW_SECONDS:
                current.append(strike)
            else:
                _flush(current)
                current = [strike]
        _flush(current)
    return combos


def _aggregate_combos(strikes) -> dict | None:
    """Aggregate combo stats from a list of strikes."""
    combos = _detect_combos(strikes)
    if not combos:
        return None

    sequences: dict[tuple, int] = {}
    guard_dropped_count = 0

    for combo in combos:
        seq = tuple(s.type for s in combo)
        sequences[seq] = sequences.get(seq, 0) + 1
        if any(s.guard_dropped for s in combo if s.guard_dropped is not None):
            guard_dropped_count += 1

    top = sorted(sequences.items(), key=lambda x: -x[1])[:3]

    return {
        "total_combos": len(combos),
        "avg_length": round(sum(len(c) for c in combos) / len(combos), 1),
        "guard_dropped_in_combo": guard_dropped_count,
        "top_sequences": [
            {"sequence": list(seq), "count": count}
            for seq, count in top
        ],
    }


# ---------------------------------------------------------------------------
# Predictability — how readable the athlete's offense is
# ---------------------------------------------------------------------------

PREDICTABILITY_MIN_TRANSITIONS = 10  # below this, entropy is noise
PREDICTABILITY_MIN_COMBOS = 5        # below this, opener/repeat stats are noise


def _compute_predictability(strikes) -> dict | None:
    """Pattern predictability over strike-to-strike transitions.

    First-order Markov view: for each strike type, the distribution of what
    follows it within COMBO_WINDOW_SECONDS. Score = 1 - normalized conditional
    entropy, scaled 0-100. 0 = maximally varied, 100 = an opponent who knows
    your last strike always knows your next one.
    """
    transitions: dict[str, dict[str, int]] = {}
    n_transitions = 0
    for group in _strikes_by_job(strikes):
        for prev, nxt in zip(group, group[1:]):
            if nxt.timestamp_seconds - prev.timestamp_seconds > COMBO_WINDOW_SECONDS:
                continue
            row = transitions.setdefault(prev.type, {})
            row[nxt.type] = row.get(nxt.type, 0) + 1
            n_transitions += 1

    if n_transitions < PREDICTABILITY_MIN_TRANSITIONS:
        return None

    types = set(transitions)
    for row in transitions.values():
        types.update(row)

    if len(types) == 1:
        score = 100
    else:
        h_cond = 0.0
        for row in transitions.values():
            row_total = sum(row.values())
            h_row = -sum((c / row_total) * math.log2(c / row_total) for c in row.values())
            h_cond += (row_total / n_transitions) * h_row
        score = round((1 - h_cond / math.log2(len(types))) * 100)

    # Most readable habits: high-probability follow-ups with enough samples
    # to mean something (rank by probability, break ties by frequency).
    top_transitions = []
    for prev, row in transitions.items():
        row_total = sum(row.values())
        if row_total < 4:
            continue
        for nxt, count in row.items():
            if count >= 3:
                top_transitions.append({
                    "after": prev,
                    "then": nxt,
                    "count": count,
                    "pct": round(count / row_total * 100),
                })
    top_transitions.sort(key=lambda t: (-t["pct"], -t["count"]))
    top_transitions = top_transitions[:3]

    combos = _detect_combos(strikes)
    top_opener = top_closer = combo_repeat_pct = None
    if len(combos) >= PREDICTABILITY_MIN_COMBOS:
        openers: dict[str, int] = {}
        closers: dict[str, int] = {}
        sequences: dict[tuple, int] = {}
        for c in combos:
            openers[c[0].type] = openers.get(c[0].type, 0) + 1
            closers[c[-1].type] = closers.get(c[-1].type, 0) + 1
            seq = tuple(s.type for s in c)
            sequences[seq] = sequences.get(seq, 0) + 1

        def _top(counts: dict[str, int]) -> dict:
            t, count = max(counts.items(), key=lambda x: x[1])
            return {"type": t, "count": count, "pct": round(count / len(combos) * 100)}

        top_opener = _top(openers)
        top_closer = _top(closers)
        top3 = sorted(sequences.values(), reverse=True)[:3]
        combo_repeat_pct = round(sum(top3) / len(combos) * 100)

    return {
        "score": score,
        "transitions_measured": n_transitions,
        "top_transitions": top_transitions,
        "top_opener": top_opener,
        "top_closer": top_closer,
        "combo_repeat_pct": combo_repeat_pct,
    }


# ---------------------------------------------------------------------------
# Fatigue curve
# ---------------------------------------------------------------------------

def _clip_offsets(clips, job_to_clip: dict) -> dict:
    """Map job_id -> its clip's start offset on the session timeline.
    Strike timestamps are clip-relative, so multi-clip aggregation must shift
    each clip's strikes by the cumulative duration of the clips before it."""
    ordered = sorted(clips, key=lambda c: c.created_at)
    start, t = {}, 0
    for c in ordered:
        start[c.id] = t
        t += c.duration_seconds or 0
    return {jid: start[cid] for jid, cid in job_to_clip.items() if cid in start}


def _compute_fatigue_curve(strikes, total_duration_seconds: int, offsets: dict | None = None) -> list[dict] | None:
    """Split session into thirds and compute output + form metrics per third.
    offsets (job_id -> seconds, from _clip_offsets) places clip-relative
    timestamps on the session timeline; omit for single-clip calls."""
    if not strikes or not total_duration_seconds or total_duration_seconds < 30:
        return None

    third = total_duration_seconds / 3

    def _session_ts(s):
        return s.timestamp_seconds + (offsets.get(s.job_id, 0) if offsets else 0)

    def _third_stats(t_start, t_end):
        s = [x for x in strikes if t_start <= _session_ts(x) < t_end]
        ext = [x.arm_extension for x in s if x.arm_extension is not None]
        duration_min = (t_end - t_start) / 60
        return {
            "strikes": len(s),
            "strikes_per_minute": round(len(s) / duration_min, 1) if duration_min > 0 else None,
            "avg_arm_extension": round(sum(ext) / len(ext), 3) if ext else None,
        }

    return [
        {"third": 1, **_third_stats(0, third)},
        {"third": 2, **_third_stats(third, third * 2)},
        {"third": 3, **_third_stats(third * 2, total_duration_seconds)},
    ]


# ---------------------------------------------------------------------------
# Summary aggregation
# ---------------------------------------------------------------------------

def _aggregate_strikes(strikes) -> dict:
    """Shared strike aggregation — used by both clip and session summaries."""
    by_type: dict[str, int] = {}
    for s in strikes:
        by_type[s.type] = by_type.get(s.type, 0) + 1

    guard_measured = [s for s in strikes if s.guard_dropped is not None]
    guard_dropped_count = sum(1 for s in guard_measured if s.guard_dropped)
    guard_drop_rate = (
        round(guard_dropped_count / len(guard_measured), 3) if guard_measured else None
    )
    guard_by_type: dict[str, dict] = {}
    for s in guard_measured:
        entry = guard_by_type.setdefault(s.type, {"measured": 0, "dropped": 0})
        entry["measured"] += 1
        if s.guard_dropped:
            entry["dropped"] += 1
    for entry in guard_by_type.values():
        entry["rate"] = round(entry["dropped"] / entry["measured"], 3)

    ext_measured = [s for s in strikes if s.arm_extension is not None]
    avg_ext = (
        round(sum(s.arm_extension for s in ext_measured) / len(ext_measured), 3)
        if ext_measured else None
    )
    ext_by_type: dict[str, list[float]] = {}
    for s in ext_measured:
        ext_by_type.setdefault(s.type, []).append(s.arm_extension)
    ext_by_type_avg = {t: round(sum(vs) / len(vs), 3) for t, vs in ext_by_type.items()}

    return {
        "total_strikes": len(strikes),
        "strikes_by_type": by_type,
        "guard_discipline": {
            "total_measured": len(guard_measured),
            "dropped_count": guard_dropped_count,
            "drop_rate": guard_drop_rate,
            "by_type": guard_by_type,
        },
        "arm_extension": {
            "avg": avg_ext,
            "by_type": ext_by_type_avg,
        },
    }


def _aggregate_velocity_and_recovery(strikes) -> dict:
    """Aggregate peak velocity, recovery time, and hip rotation stats."""
    velocities  = [s.peak_velocity    for s in strikes if getattr(s, "peak_velocity",    None) is not None]
    recoveries  = [s.recovery_seconds for s in strikes if getattr(s, "recovery_seconds", None) is not None]
    hip_rots    = [s.hip_rotation     for s in strikes if getattr(s, "hip_rotation",     None) is not None]
    return {
        "avg_peak_velocity":    round(sum(velocities)  / len(velocities),  4) if velocities  else None,
        "max_peak_velocity":    round(max(velocities),                      4) if velocities  else None,
        "avg_recovery_seconds": round(sum(recoveries)  / len(recoveries),  3) if recoveries  else None,
        "avg_hip_rotation":     round(sum(hip_rots)    / len(hip_rots),    2) if hip_rots    else None,
    }


def _quality_grade(score: float | None) -> str | None:
    if score is None:
        return None
    return "good" if score >= 0.7 else "limited" if score >= 0.5 else "low"


def _build_data_quality(pose_quality_score, subject_confidence) -> dict | None:
    """Footage-quality block for the LLM payload — drives hedging rules so the
    model never coaches confidently on unreliable data."""
    if pose_quality_score is None and subject_confidence is None:
        return None
    return {
        "pose_quality_score": pose_quality_score,
        "grade": _quality_grade(pose_quality_score),
        "subject_confidence": subject_confidence,
    }


def build_clip_summary(clip, strikes, user=None) -> dict:
    """Summary for a single clip — same dict shape as build_session_summary."""
    duration = clip.duration_seconds or 0
    total_strikes = len(strikes)
    agg = _aggregate_strikes(strikes)
    return {
        "sport": clip.sport,
        "session_type": getattr(clip, "clip_type", None),
        "data_quality": _build_data_quality(
            getattr(clip, "pose_quality_score", None),
            getattr(clip, "subject_confidence", None),
        ),
        "athlete_notes": getattr(clip, "notes", None),
        "experience_level": getattr(user, "experience_level", None) if user else None,
        "training_phase": None,
        "opponent_context": None,
        "stance": getattr(clip, "stance", None),
        "head_movement_score": getattr(clip, "head_movement_score", None),
        "duration_seconds": duration,
        "strikes_per_minute": (
            round(total_strikes / (duration / 60), 1) if duration > 0 else None
        ),
        "velocity_and_recovery": _aggregate_velocity_and_recovery(strikes),
        "combos": _aggregate_combos(strikes),
        "predictability": _compute_predictability(strikes),
        "fatigue_curve": _compute_fatigue_curve(strikes, duration),
        **agg,
    }


def build_session_summary(session, clips, strikes, user=None, job_to_clip: dict | None = None) -> dict:
    """Summary across all clips in a session. job_to_clip (job_id -> clip_id)
    lets the fatigue curve place clip-relative strike times on the session
    timeline; without it the curve treats timestamps as session-absolute."""
    total_duration = sum(c.duration_seconds or 0 for c in clips)
    offsets = _clip_offsets(clips, job_to_clip) if job_to_clip else None
    total_strikes = len(strikes)
    agg = _aggregate_strikes(strikes)

    head_scores = [c.head_movement_score for c in clips if getattr(c, "head_movement_score", None) is not None]
    avg_head_movement = round(sum(head_scores) / len(head_scores), 3) if head_scores else None

    stances = [c.stance for c in clips if getattr(c, "stance", None) not in (None, "unknown")]
    stance = max(set(stances), key=stances.count) if stances else None

    # Session quality = the worst clip's quality — one bad clip can distort
    # the aggregates, so hedge to the weakest link.
    q_scores = [c.pose_quality_score for c in clips if getattr(c, "pose_quality_score", None) is not None]
    s_confs = [c.subject_confidence for c in clips if getattr(c, "subject_confidence", None) is not None]

    return {
        "sport": session.sport,
        "session_type": session.session_type,
        "data_quality": _build_data_quality(
            min(q_scores) if q_scores else None,
            min(s_confs) if s_confs else None,
        ),
        "athlete_notes": getattr(session, "notes", None),
        "training_phase": getattr(session, "training_phase", None),
        "opponent_context": getattr(session, "opponent_context", None),
        "experience_level": getattr(user, "experience_level", None) if user else None,
        "stance": stance,
        "head_movement_score": avg_head_movement,
        "duration_seconds": total_duration,
        "strikes_per_minute": (
            round(total_strikes / (total_duration / 60), 1) if total_duration > 0 else None
        ),
        "velocity_and_recovery": _aggregate_velocity_and_recovery(strikes),
        "combos": _aggregate_combos(strikes),
        "predictability": _compute_predictability(strikes),
        "fatigue_curve": _compute_fatigue_curve(strikes, total_duration, offsets=offsets),
        **agg,
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

EXPERIENCE_CONTEXT = {
    "beginner":     "This is a beginner athlete — focus on fundamental patterns and safety. Use simple language. Celebrate small wins.",
    "intermediate": "This is an intermediate athlete — expect baseline technique, focus on consistency and specific habits to fix.",
    "advanced":     "This is an advanced athlete — be precise and demanding. Reference subtle technical details. High standards expected.",
    "pro":          "This is a professional or competitive fighter — be direct, technical, and unsparing. No softening. Data drives every point.",
}

TRAINING_PHASE_CONTEXT = {
    "fight_camp":  "They are in fight camp — prioritize sharpness, timing, and eliminating bad habits under pressure. Volume context matters.",
    "off_season":  "This is off-season training — emphasize technique development over output. Volume drops are expected.",
    "recovery":    "This is a recovery session — lower output is expected. Note any technique regressions that may indicate fatigue.",
    "regular":     "Regular training session — balanced assessment of output and technique.",
}

FEW_SHOT_EXAMPLE = """
Example of excellent coaching feedback (do not copy verbatim, use as a style guide):

**Strengths**
- Jab output is strong at 18/min — above average for your level. Extension averaging 0.81 shows commitment to the punch.
- Guard discipline on hooks improved: 34% drop rate vs 58% last session — the drill work is showing.

**Areas to improve**
- Cross drops the guard 71% of the time — every cross is an invitation to a counter. Return the left hand immediately.
- Fatigue curve shows 40% drop in output in the final third with arm extension falling to 0.63. Conditioning is limiting your later rounds.
"""


def build_feedback_prompt(summary: dict) -> tuple[str, str]:
    """Returns (system_prompt, user_message) with chain-of-thought and full context."""
    sport = summary["sport"]
    sport_label = SPORT_LABELS.get(sport, sport)
    sport_ctx = SPORT_CONTEXT.get(sport, "")

    experience_level = summary.get("experience_level") or "intermediate"
    exp_ctx = EXPERIENCE_CONTEXT.get(experience_level, "")

    training_phase = summary.get("training_phase")
    phase_ctx = TRAINING_PHASE_CONTEXT.get(training_phase, "") if training_phase else ""

    dq = summary.get("data_quality") or {}
    grade = dq.get("grade")
    quality_note = ""
    if grade in ("limited", "low"):
        quality_note = (
            f"\n- This clip's footage quality grade is '{grade}' — stay tentative and lead with what is reliable."
        )

    system = f"""You are an elite martial arts coach specializing in {sport_label} with decades of experience training competitive fighters.
{sport_ctx}

{exp_ctx}
{phase_ctx}

PROCESS (follow this order internally before writing):
1. Identify the single most significant pattern in the data — what stands out most?
2. Determine what is causing it — technique flaw, fatigue, habit, or lack of training?
3. Then write the feedback below.

FORMAT your response exactly like this:

**Strengths**
- [specific observation with actual numbers from the data]
- [specific observation with actual numbers from the data]

**Areas to improve**
- [most critical issue, with numbers and a concrete fix]
- [second issue, with numbers and a concrete fix]

{FEW_SHOT_EXAMPLE}

Rules:
- Reference actual numbers from the data in every bullet
- If the athlete stated a focus/context, tailor feedback to that intent
- Calibrate tone and standards to their experience level
- Keep total response under 250 words
- No filler phrases. No "great job". Be a coach, not a cheerleader.

CONFIDENCE POLICY (non-negotiable):
- Only discuss metrics that appear in the data block. Never invent or estimate a number that isn't provided.
- If a "Footage quality" line says limited or low, acknowledge once that footage quality limits the analysis, keep claims to the most reliable metrics (strike counts, timing), and avoid strong conclusions about fine technique.
- Distinguish what was measured (counts, rates, distances) from what you infer (fatigue, habits). Frame inferences as such.{quality_note}"""

    lines = [f"Sport: {sport_label}"]
    lines.append(f"Experience level: {experience_level}")

    if summary.get("athlete_notes"):
        lines.append(f"Athlete's stated focus: {summary['athlete_notes']}")

    if summary.get("opponent_context"):
        lines.append(f"Opponent / sparring context: {summary['opponent_context']}")

    if training_phase:
        lines.append(f"Training phase: {TRAINING_PHASE_CONTEXT.get(training_phase, training_phase)}")

    if summary.get("stance"):
        lines.append(f"Detected stance: {summary['stance']}")

    if grade:
        q_line = f"Footage quality: {grade}"
        if dq.get("pose_quality_score") is not None:
            q_line += f" (score {dq['pose_quality_score']})"
        if dq.get("subject_confidence") is not None and dq["subject_confidence"] < 0.5:
            q_line += " — subject identification was uncertain (multiple people in frame)"
        lines.append(q_line)

    if summary["session_type"]:
        lines.append(f"Session type: {SESSION_TYPE_LABELS.get(summary['session_type'], summary['session_type'])}")

    d = summary["duration_seconds"]
    if d:
        lines.append(f"Duration: {d // 60}m {d % 60}s")

    spm = summary["strikes_per_minute"]
    total = summary["total_strikes"]
    lines.append(f"Total strikes: {total}" + (f" ({spm}/min)" if spm else ""))

    if summary["strikes_by_type"]:
        lines.append("\nStrike breakdown:")
        for strike_type, count in sorted(summary["strikes_by_type"].items(), key=lambda x: -x[1]):
            pct = round(count / total * 100) if total else 0
            label = strike_type.replace("_", " ").title()
            lines.append(f"  {label}: {count} ({pct}%)")

    vel = summary.get("velocity_and_recovery", {})
    if vel.get("avg_peak_velocity") is not None:
        lines.append(f"\nStrike speed (normalized velocity, higher = faster):")
        lines.append(f"  Avg peak velocity: {vel['avg_peak_velocity']}  |  Max: {vel['max_peak_velocity']}")
        if vel.get("avg_recovery_seconds") is not None:
            lines.append(f"  Avg recovery time between strikes: {vel['avg_recovery_seconds']}s")
        if vel.get("avg_hip_rotation") is not None:
            lines.append(f"  Avg hip rotation angle: {vel['avg_hip_rotation']}° (higher = more torso involvement)")

    gd = summary["guard_discipline"]
    if gd["drop_rate"] is not None:
        lines.append(f"\nGuard discipline (% of strikes where the guard hand fell below shoulder level):")
        lines.append(f"  Overall: {round(gd['drop_rate'] * 100)}% dropped ({gd['dropped_count']}/{gd['total_measured']} measured)")
        for t, entry in sorted(gd["by_type"].items(), key=lambda x: -(x[1]["rate"] or 0)):
            label = t.replace("_", " ").title()
            lines.append(f"  {label}: {round(entry['rate'] * 100)}% dropped ({entry['measured']} strikes)")

    ext = summary["arm_extension"]
    if ext["avg"] is not None:
        lines.append(f"\nArm extension (shoulder-to-wrist in torso-lengths, ~1.0 = fully extended, higher = more committed):")
        lines.append(f"  Average: {ext['avg']}")
        for t, avg in sorted(ext["by_type"].items(), key=lambda x: -x[1]):
            label = t.replace("_", " ").title()
            lines.append(f"  {label}: {avg}")

    head_movement = summary.get("head_movement_score")
    if head_movement is not None:
        level = "high" if head_movement > 0.6 else "moderate" if head_movement > 0.3 else "low"
        lines.append(f"\nHead movement score: {head_movement} / 1.0 ({level} — 0=stationary, 1=active slipping/bobbing)")

    combos = summary.get("combos")
    if combos:
        lines.append(f"\nCombos (strikes within {COMBO_WINDOW_SECONDS}s):")
        lines.append(f"  Total: {combos['total_combos']}, avg length: {combos['avg_length']} strikes")
        lines.append(f"  Guard dropped during combo: {combos['guard_dropped_in_combo']} times")
        if combos["top_sequences"]:
            lines.append("  Top sequences:")
            for seq in combos["top_sequences"]:
                labels = " → ".join(s.replace("_", " ") for s in seq["sequence"])
                lines.append(f"    {labels} × {seq['count']}")

    pred = summary.get("predictability")
    if pred:
        lines.append("\nPredictability (0 = varied offense, 100 = an opponent can read the next strike):")
        lines.append(f"  Score: {pred['score']}/100, measured over {pred['transitions_measured']} strike-to-strike transitions")
        for t in pred["top_transitions"]:
            after = t["after"].replace("_", " ")
            then = t["then"].replace("_", " ")
            lines.append(f"  After the {after}, the {then} follows {t['pct']}% of the time ({t['count']}x)")
        if pred.get("top_opener"):
            o = pred["top_opener"]
            lines.append(f"  Opens {o['pct']}% of combos with the {o['type'].replace('_', ' ')}")
        if pred.get("top_closer"):
            c = pred["top_closer"]
            lines.append(f"  Ends {c['pct']}% of combos with the {c['type'].replace('_', ' ')}")
        if pred.get("combo_repeat_pct") is not None:
            lines.append(f"  {pred['combo_repeat_pct']}% of combos are one of the top 3 sequences")
        lines.append(
            "  Note: heavy repetition is expected and fine in pad work or drilling; "
            "in sparring, bag work, or shadow boxing a high score means a live opponent could time and counter the pattern."
        )

    fatigue = summary.get("fatigue_curve")
    if fatigue:
        lines.append("\nFatigue curve (session thirds):")
        for t in fatigue:
            ext_str = f", avg extension {t['avg_arm_extension']}" if t["avg_arm_extension"] else ""
            lines.append(
                f"  Third {t['third']}: {t['strikes']} strikes"
                + (f" ({t['strikes_per_minute']}/min)" if t["strikes_per_minute"] else "")
                + ext_str
            )

    return system, "\n".join(lines)


# ---------------------------------------------------------------------------
# LLM call
# ---------------------------------------------------------------------------

def _llm_config(llm_model: str) -> dict:
    """Return model-specific config. R1 uses higher tokens and different temperature."""
    is_reasoner = llm_model == "deepseek-reasoner"
    return {
        "model": llm_model,
        "max_tokens": 800 if is_reasoner else 400,
        # R1 doesn't support system-level temperature adjustment the same way
        "temperature": 1.0 if is_reasoner else 0.7,
    }


async def generate_feedback(summary: dict, llm_model: str = "deepseek-chat") -> str:
    """Call DeepSeek with the session summary and return the coaching text."""
    system, user_message = build_feedback_prompt(summary)
    cfg = _llm_config(llm_model)

    client = AsyncOpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com/v1",
    )

    response = await client.chat.completions.create(
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        **cfg,
    )

    return response.choices[0].message.content


def generate_feedback_sync(summary: dict, llm_model: str = "deepseek-chat") -> str:
    """Synchronous version for use in the Modal inference function (which runs in a sync context)."""
    system, user_message = build_feedback_prompt(summary)
    cfg = _llm_config(llm_model)

    client = OpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com/v1",
    )

    response = client.chat.completions.create(
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        **cfg,
    )

    return response.choices[0].message.content


def compute_session_hash(summary: dict) -> str:
    """MD5 of the session summary dict — used to detect when cached feedback is stale."""
    return hashlib.md5(json.dumps(summary, sort_keys=True).encode()).hexdigest()


# ---------------------------------------------------------------------------
# Trend feedback (cross-session)
# ---------------------------------------------------------------------------

def build_trend_summary(sessions: list, strikes_by_session: dict) -> dict:
    """
    Build a structured summary across multiple sessions for trend analysis.
    sessions: list of Session objects, ordered oldest → newest
    strikes_by_session: dict of str(session_id) → list of Strike objects
    """
    session_data = []
    for session in sessions:
        strikes = strikes_by_session.get(str(session.id), [])
        if not strikes:
            continue
        agg = _aggregate_strikes(strikes)
        session_data.append({
            "label": session.label or "Untitled session",
            "sport": session.sport,
            "session_type": session.session_type,
            "date": session.created_at.strftime("%b %d"),
            **agg,
        })

    # Compute first → last deltas for key metrics
    deltas = {}
    if len(session_data) >= 2:
        first = session_data[0]
        last = session_data[-1]

        first_gd = first["guard_discipline"]["drop_rate"]
        last_gd = last["guard_discipline"]["drop_rate"]
        if first_gd is not None and last_gd is not None:
            deltas["guard_drop_rate"] = round(last_gd - first_gd, 3)  # negative = improving

        first_ext = first["arm_extension"]["avg"]
        last_ext = last["arm_extension"]["avg"]
        if first_ext is not None and last_ext is not None:
            deltas["arm_extension_avg"] = round(last_ext - first_ext, 3)  # positive = improving

        deltas["total_strikes"] = last["total_strikes"] - first["total_strikes"]

    return {
        "sport": sessions[0].sport if sessions else "boxing",
        "session_count": len(session_data),
        "sessions": session_data,
        "deltas": deltas,
    }


def build_trend_prompt(summary: dict) -> tuple[str, str]:
    """Returns (system_prompt, user_message) for trend analysis."""
    sport = summary["sport"]
    sport_label = SPORT_LABELS.get(sport, sport)
    sport_ctx = SPORT_CONTEXT.get(sport, "")

    system = f"""You are an expert martial arts coach specializing in {sport_label}.
{sport_ctx}

You are reviewing a fighter's progress across multiple training sessions over time.
Identify clear trends — what is improving, what is plateauing, and what needs focused work.
Format your response exactly like this:

**Progress**
- [specific trend referencing session data and the delta between first and last session]
- [specific trend referencing session data]

**Focus areas**
- [specific metric that needs attention, with context from the trend data]
- [specific metric that needs attention]

Rules: reference actual numbers and session dates. Note whether metrics improved or declined \
between first and last session. Keep total response under 250 words. Be direct — \
tell the fighter what the data actually shows."""

    lines = [
        f"Sport: {sport_label}",
        f"Sessions analysed: {summary['session_count']}",
        "",
    ]

    for i, s in enumerate(summary["sessions"]):
        label = s.get("label", f"Session {i + 1}")
        date = s.get("date", "")
        total = s["total_strikes"]
        gd = s["guard_discipline"]["drop_rate"]
        ext = s["arm_extension"]["avg"]

        session_lines = [f"Session {i + 1} — {label} ({date}):"]
        session_lines.append(f"  Strikes: {total}")
        if gd is not None:
            session_lines.append(f"  Guard drop rate: {round(gd * 100)}%")
        if ext is not None:
            session_lines.append(f"  Avg arm extension: {ext}")
        lines.extend(session_lines)
        lines.append("")

    if summary["deltas"]:
        lines.append("Deltas (first → last session):")
        d = summary["deltas"]
        if "guard_drop_rate" in d:
            direction = "improved ↓" if d["guard_drop_rate"] < 0 else "worsened ↑"
            lines.append(f"  Guard drop rate: {direction} by {abs(round(d['guard_drop_rate'] * 100))}%")
        if "arm_extension_avg" in d:
            direction = "improved ↑" if d["arm_extension_avg"] > 0 else "declined ↓"
            lines.append(f"  Arm extension: {direction} by {abs(d['arm_extension_avg'])}")
        if "total_strikes" in d:
            direction = "up" if d["total_strikes"] > 0 else "down"
            lines.append(f"  Strike volume: {direction} {abs(d['total_strikes'])} strikes")

    return system, "\n".join(lines)


async def generate_trend_feedback(summary: dict) -> str:
    """Call DeepSeek with the trend summary and return the coaching text."""
    system, user_message = build_trend_prompt(summary)

    client = AsyncOpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com/v1",
    )

    response = await client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        max_tokens=500,
        temperature=0.7,
    )

    return response.choices[0].message.content
