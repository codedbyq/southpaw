export default function StatsBar({ stats }) {
  if (!stats) return null

  const tw = stats.this_week
  const lw = stats.last_week || {}

  // Current weekday as Mon=0 … Sun=6 to match the backend's training_days indices
  const todayIdx = (new Date().getDay() + 6) % 7
  const trainingDays = tw.training_days || []

  // Guard discipline = inverse of guard-drop rate
  const guardPct = tw.guard_drop_rate !== null && tw.guard_drop_rate !== undefined
    ? Math.round((1 - tw.guard_drop_rate) * 100)
    : null

  // Week-over-week deltas
  const strikesTrend = lw.strikes > 0
    ? (() => {
        const pct = Math.round(((tw.strikes - lw.strikes) / lw.strikes) * 100)
        return { up: pct >= 0, text: `${pct >= 0 ? '↑ +' : '↓ '}${pct}% vs last week` }
      })()
    : null

  const guardTrend = (guardPct !== null && lw.guard_drop_rate !== null && lw.guard_drop_rate !== undefined)
    ? (() => {
        const lastPct = Math.round((1 - lw.guard_drop_rate) * 100)
        const d = guardPct - lastPct
        return { up: d >= 0, text: `${d >= 0 ? '↑ +' : '↓ '}${d}pts` }
      })()
    : null

  return (
    <div className="grid grid-cols-2 gap-3 mb-10 md:grid-cols-4">
      {/* Week streak — highlighted, with per-day training pips */}
      <Tile highlight label="Week streak">
        <Value highlight>{stats.streak_weeks}<Unit>{stats.streak_weeks === 1 ? 'wk' : 'wks'}</Unit></Value>
        <div className="mt-2 flex gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map(i => (
            <span
              key={i}
              className={`h-2 w-2 rounded-sm ${
                i === todayIdx && trainingDays.includes(i)
                  ? 'bg-kiwi shadow-[0_0_5px_#ccff00]'
                  : trainingDays.includes(i)
                    ? 'bg-kiwi'
                    : 'bg-surface3'
              }`}
            />
          ))}
        </div>
      </Tile>

      {/* Strikes this week — with WoW delta */}
      <Tile label="Strikes this week">
        <Value>{tw.strikes.toLocaleString()}</Value>
        {strikesTrend
          ? <Trend up={strikesTrend.up}>{strikesTrend.text}</Trend>
          : <Sub>this week</Sub>}
      </Tile>

      {/* Guard discipline — with WoW delta */}
      <Tile label="Guard discipline">
        <Value>{guardPct !== null ? <>{guardPct}<Unit>%</Unit></> : '—'}</Value>
        {guardTrend
          ? <Trend up={guardTrend.up}>{guardTrend.text}</Trend>
          : <Sub>{guardPct !== null ? 'this week' : 'no data yet'}</Sub>}
      </Tile>

      {/* Avg arm extension */}
      <Tile label="Avg arm extension">
        <Value>{tw.avg_arm_extension != null ? tw.avg_arm_extension.toFixed(2) : '—'}</Value>
        <Sub>{tw.avg_arm_extension != null ? 'focus area' : 'no data yet'}</Sub>
      </Tile>
    </div>
  )
}

function Tile({ label, highlight = false, children }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-surface p-5 transition-colors ${
      highlight ? 'border-kiwi' : 'border-line hover:border-line2'
    }`}>
      {highlight && <span className="absolute inset-x-0 top-0 h-0.5 bg-kiwi" />}
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      {children}
    </div>
  )
}

function Value({ highlight = false, children }) {
  return (
    <p className={`mt-2.5 font-display text-[40px] font-black leading-none tabular-nums ${highlight ? 'text-kiwi' : 'text-text'}`}>
      {children}
    </p>
  )
}

const Unit = ({ children }) => <span className="ml-1 font-display text-sm font-semibold text-muted">{children}</span>
const Sub = ({ children }) => <p className="mt-2 text-xs text-muted">{children}</p>
const Trend = ({ up, children }) => (
  <p className={`mt-1.5 inline-flex items-center text-[11px] font-semibold ${up ? 'text-kiwi' : 'text-danger'}`}>{children}</p>
)
