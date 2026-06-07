import { useNavigate } from 'react-router-dom'
import { SportTag, SessionTypeTag } from './Tag'

const SPORT_EMOJI = { boxing: '🥊', muay_thai: '🦵', mma: '🤼' }

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
      className="group flex cursor-pointer items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-4 transition-all hover:border-line2 hover:bg-surface2 sm:gap-4 sm:px-5"
    >
      {/* Thumbnail — sport emoji with hover play overlay */}
      <div className="relative flex h-12 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-surface2 to-surface3 text-2xl">
        {SPORT_EMOJI[session.sport] || '🎬'}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="text-lg text-white">▶</span>
        </div>
      </div>

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

      <div className="flex flex-shrink-0 gap-4 sm:gap-6">
        <Metric label="Strikes" value={session.total_strikes} format={n => n.toLocaleString()} />
        <Metric label="/ min" value={session.strikes_per_minute} format={n => n.toFixed(1)} />
        <Metric label="Guard" value={guard} format={n => `${Math.round(n * 100)}%`} valueClass={guardColor} />
      </div>
      <span className="hidden flex-shrink-0 text-xl text-muted transition-colors group-hover:text-kiwi sm:block">›</span>
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
