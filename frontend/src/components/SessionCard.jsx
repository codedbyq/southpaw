import { useNavigate } from 'react-router-dom'
import { SportTag, SessionTypeTag } from './Tag'

export default function SessionCard({ session }) {
  const navigate = useNavigate()

  const guard = session.guard_drop_rate
  const guardColor = guard == null ? 'text-text'
    : guard < 0.35 ? 'text-kiwi'
    : guard > 0.5 ? 'text-danger'
    : 'text-text'

  return (
    <div
      onClick={() => navigate(`/sessions/${session.id}`)}
      className="group flex cursor-pointer items-center gap-4 rounded-2xl border border-line bg-surface px-5 py-4 transition-all hover:border-line2 hover:bg-surface2"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[17px] font-bold tracking-wide text-text">
          {session.label || 'Untitled session'}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <SportTag sport={session.sport} />
          <SessionTypeTag type={session.session_type} />
          <span className="text-xs text-muted">
            {new Date(session.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
            })}
          </span>
        </div>
      </div>

      <div className="flex flex-shrink-0 gap-6">
        <Metric label="Clips" value={session.clip_count} format={n => n} />
        <Metric label="Strikes" value={session.total_strikes} format={n => n.toLocaleString()} />
        <Metric label="/ min" value={session.strikes_per_minute} format={n => n.toFixed(1)} />
        <Metric label="Guard" value={guard} format={n => `${Math.round(n * 100)}%`} valueClass={guardColor} />
      </div>
      <span className="flex-shrink-0 text-xl text-muted transition-colors group-hover:text-kiwi">›</span>
    </div>
  )
}

function Metric({ label, value, format, valueClass = 'text-text' }) {
  return (
    <div className="text-right">
      <p className={`font-display text-[22px] font-extrabold leading-none tabular-nums ${valueClass}`}>
        {value != null ? format(value) : <span className="text-muted">—</span>}
      </p>
      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{label}</p>
    </div>
  )
}
