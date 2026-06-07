export default function StatsBar({ stats }) {
  if (!stats) return null

  const { this_week, streak_weeks, all_time } = stats

  const guardPct = this_week.guard_drop_rate !== null
    ? `${Math.round((1 - this_week.guard_drop_rate) * 100)}%`
    : '—'

  const items = [
    {
      value: streak_weeks,
      label: 'Week streak',
      sub: streak_weeks === 0 ? 'Train this week to start' : 'Keep it going!',
      highlight: true,
    },
    {
      value: this_week.sessions,
      label: this_week.sessions === 1 ? 'Session' : 'Sessions',
      sub: 'this week',
    },
    {
      value: this_week.strikes.toLocaleString(),
      label: this_week.strikes === 1 ? 'Strike' : 'Strikes',
      sub: 'this week',
    },
    {
      value: guardPct,
      label: 'Guard discipline',
      sub: this_week.guard_drop_rate !== null ? 'this week' : 'no data yet',
    },
  ]

  return (
    <div className="grid grid-cols-4 gap-3 mb-10">
      {items.map((item) => (
        <div
          key={item.label}
          className={`relative overflow-hidden rounded-2xl border bg-surface p-5 transition-colors ${
            item.highlight ? 'border-kiwi' : 'border-line hover:border-line2'
          }`}
        >
          {item.highlight && <span className="absolute inset-x-0 top-0 h-0.5 bg-kiwi" />}
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{item.label}</p>
          <p className={`mt-2.5 font-display text-[40px] font-black leading-none tabular-nums ${
            item.highlight ? 'text-kiwi' : 'text-text'
          }`}>
            {item.value}
          </p>
          <p className="mt-2 text-xs text-muted">{item.sub}</p>
        </div>
      ))}
    </div>
  )
}
