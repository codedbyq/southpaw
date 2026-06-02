import { useNavigate } from 'react-router-dom'

const SPORT_LABELS = {
  boxing:    'Boxing',
  muay_thai: 'Muay Thai',
  mma:       'MMA',
}

const SESSION_TYPE_LABELS = {
  sparring: 'Sparring',
  bag:      'Bag work',
  pads:     'Pads',
  shadow:   'Shadow boxing',
}

export default function SessionCard({ session }) {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate(`/sessions/${session.id}`)}
      className="p-5 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 cursor-pointer transition-colors"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium text-white truncate">
            {session.label || 'Untitled session'}
          </p>
          <div className="flex items-center flex-wrap gap-2 mt-1.5">
            <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full">
              {SPORT_LABELS[session.sport] || session.sport}
            </span>
            {session.session_type && (
              <span className="text-xs px-2 py-0.5 bg-gray-800 text-gray-300 rounded-full">
                {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
              </span>
            )}
            <span className="text-xs text-gray-500">
              {new Date(session.created_at).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </span>
          </div>
        </div>
        <span className="text-sm text-indigo-400 shrink-0 mt-0.5">View →</span>
      </div>

      <div className="grid grid-cols-4 gap-3 mt-4">
        <Stat label="Clips" value={session.clip_count} format={n => n} />
        <Stat label="Strikes" value={session.total_strikes} format={n => n.toLocaleString()} />
        <Stat label="Per min" value={session.strikes_per_minute} format={n => n.toFixed(1)} />
        <Stat label="Guard drops" value={session.guard_drop_rate} format={n => `${Math.round(n * 100)}%`} />
      </div>
    </div>
  )
}

function Stat({ label, value, format }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-sm font-medium tabular-nums mt-0.5">
        {value != null ? format(value) : <span className="text-gray-600">—</span>}
      </p>
    </div>
  )
}
