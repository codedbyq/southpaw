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
        "duration_seconds": duration,
        "strikes_per_minute": (
            round(total_strikes / (duration / 60), 1) if duration > 0 else None
        ),
        **agg,
    }


def build_session_summary(session, clips, strikes) -> dict:
    """Summary across all clips in a session."""
    total_duration = sum(c.duration_seconds or 0 for c in clips)
    total_strikes = len(strikes)
    agg = _aggregate_strikes(strikes)
    return {
        "sport": session.sport,
        "session_type": session.session_type,
        "duration_seconds": total_duration,
        "strikes_per_minute": (
            round(total_strikes / (total_duration / 60), 1) if total_duration > 0 else None
        ),
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

Rules: reference actual numbers from the data. Keep total response under 200 words. \
No filler phrases like "great job" or "keep it up". Be a coach, not a cheerleader."""

    lines = [f"Sport: {sport_label}"]

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
