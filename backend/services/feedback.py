"""
LLM feedback pipeline.

build_session_summary() — aggregates strike rows into a structured dict
build_feedback_prompt() — turns the summary into a system + user prompt
generate_feedback()     — calls DeepSeek and returns the coaching text
compute_session_hash()  — MD5 of summary dict, used for cache invalidation
"""

import hashlib
import json

from openai import AsyncOpenAI, OpenAI
from core.config import settings


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


def _detect_combos(strikes) -> list[list]:
    """Group strikes into combos — consecutive strikes within COMBO_WINDOW_SECONDS."""
    if not strikes:
        return []
    sorted_strikes = sorted(strikes, key=lambda s: s.timestamp_seconds)
    combos, current = [], [sorted_strikes[0]]
    for strike in sorted_strikes[1:]:
        if strike.timestamp_seconds - current[-1].timestamp_seconds <= COMBO_WINDOW_SECONDS:
            current.append(strike)
        else:
            if len(current) >= MIN_COMBO_LENGTH:
                combos.append(current)
            current = [strike]
    if len(current) >= MIN_COMBO_LENGTH:
        combos.append(current)
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
# Fatigue curve
# ---------------------------------------------------------------------------

def _compute_fatigue_curve(strikes, total_duration_seconds: int) -> list[dict] | None:
    """Split session into thirds and compute output + form metrics per third."""
    if not strikes or not total_duration_seconds or total_duration_seconds < 30:
        return None

    third = total_duration_seconds / 3

    def _third_stats(t_start, t_end):
        s = [x for x in strikes if t_start <= x.timestamp_seconds < t_end]
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


def build_clip_summary(clip, strikes) -> dict:
    """Summary for a single clip — same dict shape as build_session_summary."""
    duration = clip.duration_seconds or 0
    total_strikes = len(strikes)
    agg = _aggregate_strikes(strikes)
    return {
        "sport": clip.sport,
        "session_type": None,
        "athlete_notes": getattr(clip, "notes", None),
        "duration_seconds": duration,
        "strikes_per_minute": (
            round(total_strikes / (duration / 60), 1) if duration > 0 else None
        ),
        "head_movement_score": getattr(clip, "head_movement_score", None),
        "combos": _aggregate_combos(strikes),
        "fatigue_curve": _compute_fatigue_curve(strikes, duration),
        **agg,
    }


def build_session_summary(session, clips, strikes) -> dict:
    """Summary across all clips in a session."""
    total_duration = sum(c.duration_seconds or 0 for c in clips)
    total_strikes = len(strikes)
    agg = _aggregate_strikes(strikes)

    # Average head movement score across clips that have it
    head_scores = [c.head_movement_score for c in clips if getattr(c, "head_movement_score", None) is not None]
    avg_head_movement = round(sum(head_scores) / len(head_scores), 3) if head_scores else None

    return {
        "sport": session.sport,
        "session_type": session.session_type,
        "athlete_notes": getattr(session, "notes", None),
        "duration_seconds": total_duration,
        "strikes_per_minute": (
            round(total_strikes / (total_duration / 60), 1) if total_duration > 0 else None
        ),
        "head_movement_score": avg_head_movement,
        "combos": _aggregate_combos(strikes),
        "fatigue_curve": _compute_fatigue_curve(strikes, total_duration),
        **agg,
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def build_feedback_prompt(summary: dict) -> tuple[str, str]:
    """Returns (system_prompt, user_message)."""
    sport = summary["sport"]
    sport_label = SPORT_LABELS.get(sport, sport)
    sport_ctx = SPORT_CONTEXT.get(sport, "")

    system = f"""You are an expert martial arts coach specializing in {sport_label}.
{sport_ctx}

Analyze the session data below and give honest, specific, actionable coaching feedback.
Format your response exactly like this:

**Strengths**
- [specific observation referencing the data]
- [specific observation referencing the data]

**Areas to improve**
- [specific observation referencing the data]
- [specific observation referencing the data]

Rules: reference actual numbers from the data. If the athlete has provided a focus or context note, \
tailor your feedback to that intent — e.g. if they said they were drilling hooks, evaluate hook \
consistency rather than overall strike variety. Keep total response under 200 words. \
No filler phrases like "great job" or "keep it up". Be a coach, not a cheerleader."""

    lines = [f"Sport: {sport_label}"]

    if summary.get("athlete_notes"):
        lines.append(f"Athlete's focus / context: {summary['athlete_notes']}")

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

    gd = summary["guard_discipline"]
    if gd["drop_rate"] is not None:
        lines.append(f"\nGuard discipline (% of strikes where guard hand fell below nose):")
        lines.append(f"  Overall: {round(gd['drop_rate'] * 100)}% dropped ({gd['dropped_count']}/{gd['total_measured']} measured)")
        for t, entry in sorted(gd["by_type"].items(), key=lambda x: -(x[1]["rate"] or 0)):
            label = t.replace("_", " ").title()
            lines.append(f"  {label}: {round(entry['rate'] * 100)}% dropped ({entry['measured']} strikes)")

    ext = summary["arm_extension"]
    if ext["avg"] is not None:
        lines.append(f"\nArm extension (shoulder-to-wrist distance, 0–1 scale, higher = more extended):")
        lines.append(f"  Average: {ext['avg']}")
        for t, avg in sorted(ext["by_type"].items(), key=lambda x: -x[1]):
            label = t.replace("_", " ").title()
            lines.append(f"  {label}: {avg}")

    head_movement = summary.get("head_movement_score")
    if head_movement is not None:
        level = "high" if head_movement > 0.6 else "moderate" if head_movement > 0.3 else "low"
        lines.append(f"\nHead movement score: {head_movement} / 1.0 ({level})")
        lines.append("  (0 = stationary head, 1 = very active movement — slipping, bobbing, weaving)")

    combos = summary.get("combos")
    if combos:
        lines.append(f"\nCombos (strikes within {COMBO_WINDOW_SECONDS}s of each other):")
        lines.append(f"  Total combos: {combos['total_combos']}, avg length: {combos['avg_length']} strikes")
        lines.append(f"  Guard dropped during a combo: {combos['guard_dropped_in_combo']} times")
        if combos["top_sequences"]:
            lines.append("  Top sequences:")
            for seq in combos["top_sequences"]:
                labels = " → ".join(s.replace("_", " ") for s in seq["sequence"])
                lines.append(f"    {labels} × {seq['count']}")

    fatigue = summary.get("fatigue_curve")
    if fatigue:
        lines.append("\nFatigue curve (session split into thirds):")
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

async def generate_feedback(summary: dict) -> str:
    """Call DeepSeek with the session summary and return the coaching text."""
    system, user_message = build_feedback_prompt(summary)

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
        max_tokens=400,
        temperature=0.7,
    )

    return response.choices[0].message.content


def generate_feedback_sync(summary: dict) -> str:
    """Synchronous version for use in Celery workers (which run in a sync context)."""
    system, user_message = build_feedback_prompt(summary)

    client = OpenAI(
        api_key=settings.DEEPSEEK_API_KEY,
        base_url="https://api.deepseek.com/v1",
    )

    response = client.chat.completions.create(
        model="deepseek-chat",
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user_message},
        ],
        max_tokens=400,
        temperature=0.7,
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
