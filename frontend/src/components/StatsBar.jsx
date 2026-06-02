export default function StatsBar({ stats }) {
  if (!stats) return null

  const { this_week, streak_weeks, all_time } = stats

  const guardPct = this_week.guard_drop_rate !== null
    ? `${Math.round((1 - this_week.guard_drop_rate) * 100)}%`
    : '—'

  const items = [
    {
      icon: '🔥',
      value: streak_weeks,
      label: streak_weeks === 1 ? 'week streak' : 'week streak',
      sub: streak_weeks === 0 ? 'Train this week to start' : streak_weeks === 1 ? 'Keep it going!' : 'Keep it going!',
    },
    {
      icon: '📅',
      value: this_week.sessions,
      label: this_week.sessions === 1 ? 'session' : 'sessions',
      sub: 'this week',
    },
    {
      icon: '⚡',
      value: this_week.strikes.toLocaleString(),
      label: this_week.strikes === 1 ? 'strike' : 'strikes',
      sub: 'this week',
    },
    {
      icon: '🛡️',
      value: guardPct,
      label: 'guard discipline',
      sub: this_week.guard_drop_rate !== null ? 'this week' : 'no data yet',
    },
  ]

  return (
    <div className="grid grid-cols-4 gap-3 mb-10">
      {items.map((item) => (
        <div
          key={item.label}
          className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-1"
        >
          <span className="text-xl">{item.icon}</span>
          <span className="text-2xl font-bold text-white mt-1">{item.value}</span>
          <span className="text-xs text-gray-400">{item.label}</span>
          <span className="text-xs text-gray-600">{item.sub}</span>
        </div>
      ))}
    </div>
  )
}
