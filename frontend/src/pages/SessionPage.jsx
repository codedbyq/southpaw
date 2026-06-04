import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import ClipCard from '../components/ClipCard'
import NotificationBell from '../components/NotificationBell'

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
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const [feedback, setFeedback] = useState(null)
  const [feedbackDirty, setFeedbackDirty] = useState(true)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState(null)

  // Edit mode
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSport, setEditSport] = useState('')
  const [editType, setEditType] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  async function loadSession() {
    try {
      const [data, analyticsData] = await Promise.all([
        api.get(`/sessions/${sessionId}`),
        api.get(`/sessions/${sessionId}/analytics`).catch(() => null),
      ])
      setSession(data)
      setAnalytics(analyticsData)
      if (data.llm_summary) setFeedback(data.llm_summary)
      setFeedbackDirty(data.llm_summary_dirty)
    } catch (err) {
      if (err.message === 'Session not found') setNotFound(true)
      else console.error('Failed to load session', err)
    } finally {
      setLoading(false)
    }
  }

  function startEdit() {
    setEditLabel(session.label || '')
    setEditNotes(session.notes || '')
    setEditSport(session.sport || 'boxing')
    setEditType(session.session_type || '')
    setEditing(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const updated = await api.patch(`/sessions/${sessionId}`, {
        label: editLabel || null,
        notes: editNotes || null,
        sport: editSport,
        session_type: editType || null,
      })
      setSession(updated)
      setEditing(false)
    } catch (err) {
      console.error('Failed to save session', err)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm('Delete this session? The session data will be archived and clips will remain accessible.')) return
    setDeleting(true)
    try {
      await api.delete(`/sessions/${sessionId}`)
      navigate('/dashboard')
    } catch (err) {
      console.error('Failed to delete session', err)
      setDeleting(false)
    }
  }

  async function fetchFeedback() {
    setFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const data = await api.get(`/sessions/${sessionId}/feedback`)
      setFeedback(data.feedback)
      setFeedbackDirty(false)
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
        <div className="flex items-center gap-3">
          <NotificationBell />
          <UserButton />
        </div>
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
              {editing ? (
                <div className="space-y-3 p-4 bg-gray-900 border border-gray-700 rounded-xl">
                  <input
                    type="text"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder="Session label (optional)"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-indigo-500"
                  />
                  <div className="flex gap-3">
                    <select value={editSport} onChange={e => setEditSport(e.target.value)}
                      className="px-3 py-2 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg focus:outline-none">
                      {Object.entries(SPORT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select value={editType} onChange={e => setEditType(e.target.value)}
                      className="px-3 py-2 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg focus:outline-none">
                      <option value="">No type</option>
                      {Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="Session notes — context for the AI and coaches..."
                    rows={3}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
                  />
                  <div className="flex gap-2">
                    <button onClick={handleSave} disabled={saving}
                      className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm rounded-lg transition-colors">
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button onClick={() => setEditing(false)}
                      className="px-4 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <h1 className="text-2xl font-semibold">
                      {session.label || 'Untitled session'}
                    </h1>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={startEdit}
                        className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors">
                        Edit
                      </button>
                      <button onClick={handleDelete} disabled={deleting}
                        className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-red-900 text-gray-400 hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors">
                        {deleting ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </div>
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
                </>
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

            {/* Combo + Fatigue analytics */}
            {analytics && (analytics.combos || analytics.fatigue_curve) && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10">

                {/* Combos */}
                {analytics.combos && (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                    <h3 className="text-sm font-medium text-white mb-3">⚡ Combo breakdown</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Total combos</span>
                        <span className="text-white font-medium">{analytics.combos.total_combos}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Avg length</span>
                        <span className="text-white font-medium">{analytics.combos.avg_length} strikes</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Guard dropped in combo</span>
                        <span className="text-white font-medium">{analytics.combos.guard_dropped_in_combo}×</span>
                      </div>
                      {analytics.combos.top_sequences?.length > 0 && (
                        <div className="pt-2 border-t border-gray-800">
                          <p className="text-gray-500 text-xs mb-2">Top sequences</p>
                          {analytics.combos.top_sequences.map((seq, i) => (
                            <div key={i} className="flex justify-between text-xs mb-1">
                              <span className="text-gray-400">
                                {seq.sequence.map(s => s.replace('_', ' ')).join(' → ')}
                              </span>
                              <span className="text-gray-300">×{seq.count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Fatigue curve */}
                {analytics.fatigue_curve && (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                    <h3 className="text-sm font-medium text-white mb-3">📉 Fatigue curve</h3>
                    <div className="space-y-3">
                      {analytics.fatigue_curve.map(t => (
                        <div key={t.third}>
                          <div className="flex justify-between text-xs text-gray-500 mb-1">
                            <span>Third {t.third}</span>
                            <span>{t.strikes} strikes{t.strikes_per_minute ? ` · ${t.strikes_per_minute}/min` : ''}</span>
                          </div>
                          {/* Volume bar */}
                          <div className="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-indigo-500 rounded-full transition-all"
                              style={{
                                width: `${Math.min(100, (t.strikes / Math.max(...analytics.fatigue_curve.map(x => x.strikes))) * 100)}%`
                              }}
                            />
                          </div>
                          {t.avg_arm_extension && (
                            <p className="text-xs text-gray-600 mt-0.5">
                              Avg extension: {t.avg_arm_extension}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}

            {/* AI Coaching feedback */}
            <div className="mb-10">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Coaching feedback</h2>
                {(!feedback || feedbackDirty) && (
                  <button
                    onClick={fetchFeedback}
                    disabled={feedbackLoading}
                    className={`px-3 py-1.5 text-sm disabled:opacity-50 text-white rounded-lg transition-colors ${
                      feedbackDirty && feedback
                        ? 'bg-amber-600 hover:bg-amber-500'
                        : 'bg-indigo-600 hover:bg-indigo-500'
                    }`}
                  >
                    {feedbackLoading
                      ? 'Analysing...'
                      : feedbackDirty && feedback
                        ? 'Re-analyse'
                        : 'Analyse session'}
                  </button>
                )}
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
                  Click "Analyse session" to generate AI coaching notes.
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
