import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import ClipCard from '../components/ClipCard'

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

export default function SessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const api = useApi()

  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [feedback, setFeedback] = useState(null)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState(null)

  async function loadSession() {
    try {
      const data = await api.get(`/sessions/${sessionId}`)
      setSession(data)
    } catch (err) {
      if (err.message === 'Session not found') setNotFound(true)
      else console.error('Failed to load session', err)
    } finally {
      setLoading(false)
    }
  }

  async function fetchFeedback() {
    setFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const data = await api.get(`/sessions/${sessionId}/feedback`)
      setFeedback(data.feedback)
    } catch (err) {
      setFeedbackError(err.message || 'Failed to generate feedback')
    } finally {
      setFeedbackLoading(false)
    }
  }

  useEffect(() => {
    loadSession()
  }, [sessionId])

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/dashboard')}
            className="text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Dashboard
          </button>
          <span className="text-gray-700">·</span>
          <span className="font-bold text-lg tracking-tight">Southpaw</span>
        </div>
        <UserButton />
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-12">
        {loading && (
          <p className="text-gray-500 text-sm">Loading session...</p>
        )}

        {notFound && (
          <p className="text-gray-500 text-sm">Session not found.</p>
        )}

        {!loading && !notFound && session && (
          <>
            {/* Session header */}
            <div className="mb-8">
              <h1 className="text-2xl font-semibold">
                {session.label || 'Untitled session'}
              </h1>
              <div className="flex items-center gap-2 mt-2">
                <span className="text-xs px-2.5 py-1 bg-gray-800 text-gray-300 rounded-full">
                  {SPORT_LABELS[session.sport] || session.sport}
                </span>
                {session.session_type && (
                  <span className="text-xs px-2.5 py-1 bg-gray-800 text-gray-300 rounded-full">
                    {SESSION_TYPE_LABELS[session.session_type] || session.session_type}
                  </span>
                )}
                <span className="text-xs text-gray-500">
                  {new Date(session.created_at).toLocaleDateString('en-US', {
                    month: 'long', day: 'numeric', year: 'numeric'
                  })}
                </span>
              </div>
              {session.notes && (
                <p className="mt-3 text-sm text-gray-400">{session.notes}</p>
              )}
            </div>

            {/* Metrics row */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
              <MetricCard
                label="Total strikes"
                value={session.metrics.total_strikes}
                format={n => n.toLocaleString()}
              />
              <MetricCard
                label="Strikes / min"
                value={session.metrics.strikes_per_minute}
                format={n => n.toFixed(1)}
              />
              <MetricCard
                label="Guard drop rate"
                value={session.metrics.guard_drop_rate}
                format={n => `${Math.round(n * 100)}%`}
              />
              <MetricCard
                label="Avg arm extension"
                value={session.metrics.avg_arm_extension}
                format={n => n.toFixed(2)}
              />
            </div>

            {/* AI Coaching feedback */}
            <div className="mb-10">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Coaching feedback</h2>
                <button
                  onClick={fetchFeedback}
                  disabled={feedbackLoading}
                  className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  {feedbackLoading ? 'Analysing...' : feedback ? 'Regenerate' : 'Get feedback'}
                </button>
              </div>

              {feedbackLoading && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                  <p className="text-sm text-gray-500 animate-pulse">
                    Analysing your session data...
                  </p>
                </div>
              )}

              {feedbackError && !feedbackLoading && (
                <p className="text-sm text-red-400">{feedbackError}</p>
              )}

              {feedback && !feedbackLoading && (
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-300 leading-relaxed">
                  {renderFeedback(feedback)}
                </div>
              )}

              {!feedback && !feedbackLoading && !feedbackError && (
                <p className="text-sm text-gray-600">
                  Click "Get feedback" to generate AI coaching notes for this session.
                </p>
              )}
            </div>

            {/* Clips list */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                Clips
                <span className="ml-2 text-sm font-normal text-gray-500">
                  {session.clips.length}
                </span>
              </h2>
            </div>

            {session.clips.length === 0 ? (
              <p className="text-gray-500 text-sm">No clips in this session yet.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {session.clips.map(clip => (
                  <ClipCard key={clip.id} clip={clip} onDelete={loadSession} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}


function MetricCard({ label, value, format }) {
  return (
    <div className="bg-gray-900 rounded-xl border border-gray-800 px-4 py-4">
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className="text-xl font-semibold tabular-nums">
        {value != null ? format(value) : <span className="text-gray-600 text-base">—</span>}
      </p>
    </div>
  )
}


// Renders LLM output — handles **bold** markers from the model's formatted response
function renderFeedback(text) {
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-2" />

    const isBold = line.startsWith('**') && line.includes('**', 2)
    if (isBold) {
      const inner = line.replace(/^\*\*/, '').replace(/\*\*$/, '')
      return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{inner}</p>
    }

    // Inline **bold** within a line
    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-gray-300">
        {parts.map((part, j) =>
          j % 2 === 1 ? <strong key={j} className="text-white">{part}</strong> : part
        )}
      </p>
    )
  })
}
