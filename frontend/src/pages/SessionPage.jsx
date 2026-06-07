import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag, { SportTag, SessionTypeTag } from '../components/Tag'
import ClipCard from '../components/ClipCard'
import { SessionDetailSkeleton } from '../components/Skeleton'

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
  const [editTrainingPhase, setEditTrainingPhase] = useState('')
  const [editOpponentContext, setEditOpponentContext] = useState('')
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
    setEditTrainingPhase(session.training_phase || '')
    setEditOpponentContext(session.opponent_context || '')
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
        training_phase: editTrainingPhase || null,
        opponent_context: editOpponentContext || null,
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
    // Fetch clip count first for informative confirmation
    const { clip_count } = await api.get(`/sessions/${sessionId}/clip-count`).catch(() => ({ clip_count: 0 }))
    const clipMsg = clip_count > 0
      ? `${clip_count} clip${clip_count !== 1 ? 's' : ''} will be moved to your unorganized clips.`
      : 'This session has no clips.'
    if (!confirm(`Delete this session?\n\n${clipMsg}\n\nSession analytics and feedback will be archived.`)) return
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
    <AppLayout active="dashboard">
      <main className="mx-auto max-w-4xl px-8 py-10">
        <button
          onClick={() => navigate('/dashboard')}
          className="mb-6 flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-text"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Dashboard
        </button>

        {loading && <SessionDetailSkeleton />}

        {notFound && <p className="text-sm text-muted">Session not found.</p>}

        {!loading && !notFound && session && (
          <>
            {/* Session header */}
            <div className="mb-8">
              {editing ? (
                <div className="space-y-3 rounded-2xl border border-line2 bg-surface p-4">
                  <input
                    type="text"
                    value={editLabel}
                    onChange={e => setEditLabel(e.target.value)}
                    placeholder="Session label (optional)"
                    className="input"
                  />
                  <div className="flex gap-3">
                    <select value={editSport} onChange={e => setEditSport(e.target.value)} className="input w-auto">
                      {Object.entries(SPORT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select value={editType} onChange={e => setEditType(e.target.value)} className="input w-auto">
                      <option value="">No type</option>
                      {Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  <select value={editTrainingPhase} onChange={e => setEditTrainingPhase(e.target.value)} className="input w-auto">
                    <option value="">Training phase (optional)</option>
                    <option value="regular">Regular training</option>
                    <option value="fight_camp">Fight camp</option>
                    <option value="off_season">Off season</option>
                    <option value="recovery">Recovery</option>
                  </select>
                  <input
                    type="text"
                    value={editOpponentContext}
                    onChange={e => setEditOpponentContext(e.target.value)}
                    placeholder="Opponent context — e.g. taller southpaw with strong clinch..."
                    className="input"
                  />
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="Session notes — context for the AI and coaches..."
                    rows={2}
                    className="input resize-none"
                  />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      {saving ? 'Saving...' : 'Save'}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-4">
                    <h1 className="font-display text-[32px] font-extrabold leading-tight text-text">
                      {session.label || 'Untitled session'}
                    </h1>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <Button variant="secondary" size="sm" onClick={startEdit}>Edit</Button>
                      <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleting}>
                        {deleting ? 'Deleting...' : 'Delete'}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <SportTag sport={session.sport} />
                    <SessionTypeTag type={session.session_type} />
                    {session.training_phase && (
                      <Tag tone="muted">{session.training_phase.replace('_', ' ')}</Tag>
                    )}
                    <span className="text-xs text-muted">
                      {new Date(session.created_at).toLocaleDateString('en-US', {
                        month: 'long', day: 'numeric', year: 'numeric'
                      })}
                    </span>
                  </div>
                  {session.notes && (
                    <p className="mt-3 text-sm text-text3">{session.notes}</p>
                  )}
                  {session.opponent_context && (
                    <p className="mt-1 text-xs text-muted">Opponent: {session.opponent_context}</p>
                  )}
                </>
              )}
            </div>

            {/* Metrics row */}
            <div className="mb-10 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MetricCard
                label="Total strikes"
                value={session.metrics.total_strikes}
                format={n => n.toLocaleString()}
                highlight
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
                tone={session.metrics.guard_drop_rate > 0.5 ? 'danger' : session.metrics.guard_drop_rate > 0.35 ? 'warning' : 'default'}
              />
              <MetricCard
                label="Avg arm extension"
                value={session.metrics.avg_arm_extension}
                format={n => n.toFixed(2)}
              />
            </div>

            {/* Combo + Fatigue analytics */}
            {analytics && (analytics.combos || analytics.fatigue_curve || analytics.head_movement_score != null) && (
              <div className="mb-10 grid grid-cols-1 gap-4 sm:grid-cols-2">

                {/* Combos */}
                {analytics.combos && (
                  <div className="rounded-2xl border border-line bg-surface p-5">
                    <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-text">⚡ Combo breakdown</h3>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-text3">Total combos</span>
                        <span className="font-medium tabular-nums text-text">{analytics.combos.total_combos}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text3">Avg length</span>
                        <span className="font-medium tabular-nums text-text">{analytics.combos.avg_length} strikes</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-text3">Guard dropped in combo</span>
                        <span className="font-medium tabular-nums text-text">{analytics.combos.guard_dropped_in_combo}×</span>
                      </div>
                      {analytics.combos.top_sequences?.length > 0 && (
                        <div className="border-t border-line pt-2">
                          <p className="mb-2 text-xs text-muted">Top sequences</p>
                          {analytics.combos.top_sequences.map((seq, i) => (
                            <div key={i} className="mb-1 flex justify-between text-xs">
                              <span className="text-text3">
                                {seq.sequence.map(s => s.replace('_', ' ')).join(' → ')}
                              </span>
                              <span className="tabular-nums text-text2">×{seq.count}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Fatigue curve */}
                {analytics.fatigue_curve && (
                  <div className="rounded-2xl border border-line bg-surface p-5">
                    <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-text">📉 Fatigue curve</h3>
                    <div className="space-y-3">
                      {analytics.fatigue_curve.map(t => (
                        <div key={t.third}>
                          <div className="mb-1 flex justify-between text-xs text-muted">
                            <span>Third {t.third}</span>
                            <span className="tabular-nums">{t.strikes} strikes{t.strikes_per_minute ? ` · ${t.strikes_per_minute}/min` : ''}</span>
                          </div>
                          {/* Volume bar */}
                          <div className="h-2 w-full overflow-hidden rounded-full bg-surface3">
                            <div
                              className="h-full rounded-full bg-kiwi transition-all duration-[600ms]"
                              style={{
                                width: `${Math.min(100, (t.strikes / Math.max(...analytics.fatigue_curve.map(x => x.strikes))) * 100)}%`
                              }}
                            />
                          </div>
                          {t.avg_arm_extension && (
                            <p className="mt-0.5 text-xs text-muted">
                              Avg extension: {t.avg_arm_extension}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Head movement */}
                {analytics.head_movement_score != null && (
                  <div className="rounded-2xl border border-line bg-surface p-5">
                    <h3 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-text">🎯 Head movement</h3>
                    <div className="mb-3 flex items-end gap-3">
                      <span className="font-display text-3xl font-black tabular-nums text-text">
                        {Math.round(analytics.head_movement_score * 100)}
                      </span>
                      <span className="mb-1 text-sm text-muted">/ 100</span>
                      <span className={`mb-1 text-sm font-medium ${
                        analytics.head_movement_score > 0.6 ? 'text-kiwi' :
                        analytics.head_movement_score > 0.3 ? 'text-warning' : 'text-danger'
                      }`}>
                        {analytics.head_movement_score > 0.6 ? 'Active' :
                         analytics.head_movement_score > 0.3 ? 'Moderate' : 'Low'}
                      </span>
                    </div>
                    {/* Bar */}
                    <div className="mb-3 h-2 w-full overflow-hidden rounded-full bg-surface3">
                      <div
                        className={`h-full rounded-full transition-all duration-[600ms] ${
                          analytics.head_movement_score > 0.6 ? 'bg-kiwi' :
                          analytics.head_movement_score > 0.3 ? 'bg-warning' : 'bg-danger'
                        }`}
                        style={{ width: `${analytics.head_movement_score * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted">
                      Measures nose position variance — slipping, bobbing and weaving relative to stance.
                    </p>
                  </div>
                )}

              </div>
            )}

            {/* AI Coaching feedback */}
            <div className="mb-10">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-text">Coaching feedback</h2>
                {session.clips.length < 2 ? (
                  <span className="text-xs italic text-muted">
                    Add at least 2 clips to unlock session feedback
                  </span>
                ) : (!feedback || feedbackDirty) && (
                  <Button
                    size="sm"
                    variant={feedbackDirty && feedback ? 'secondary' : 'primary'}
                    onClick={fetchFeedback}
                    disabled={feedbackLoading}
                  >
                    {feedbackLoading
                      ? 'Analysing...'
                      : feedbackDirty && feedback
                        ? 'Re-analyse'
                        : 'Analyse session'}
                  </Button>
                )}
              </div>

              {feedbackLoading && (
                <div className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5">
                  <span className="absolute inset-y-0 left-0 w-[3px] bg-kiwi" />
                  <p className="animate-pulse text-sm text-muted">
                    Analysing your session data...
                  </p>
                </div>
              )}

              {feedbackError && !feedbackLoading && (
                <p className="text-sm text-danger">{feedbackError}</p>
              )}

              {feedback && !feedbackLoading && (
                <div className="relative overflow-hidden rounded-2xl border border-line bg-surface p-5 text-sm leading-relaxed text-text2">
                  <span className="absolute inset-y-0 left-0 w-[3px] bg-kiwi" />
                  {renderFeedback(feedback)}
                </div>
              )}

              {!feedback && !feedbackLoading && !feedbackError && (
                <p className="text-sm text-muted">
                  Click "Analyse session" to generate AI coaching notes.
                </p>
              )}
            </div>

            {/* Clips list */}
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-text">
                Clips
                <span className="ml-2 font-sans text-sm font-normal text-muted">
                  {session.clips.length}
                </span>
              </h2>
            </div>

            {session.clips.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line py-10 text-center">
                <p className="mb-1 text-sm text-muted">No clips in this session yet.</p>
                <p className="text-xs text-muted">Upload a clip and assign it to this session to get started.</p>
              </div>
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
    </AppLayout>
  )
}


function MetricCard({ label, value, format, highlight = false, tone = 'default' }) {
  const valueColor = tone === 'danger' ? 'text-danger'
    : tone === 'warning' ? 'text-warning'
    : highlight ? 'text-kiwi'
    : 'text-text'
  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-surface px-4 py-4 ${highlight ? 'border-kiwi' : 'border-line'}`}>
      {highlight && <span className="absolute inset-x-0 top-0 h-0.5 bg-kiwi" />}
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <p className={`font-display text-[32px] font-black leading-none tabular-nums ${valueColor}`}>
        {value != null ? format(value) : <span className="text-base text-muted">—</span>}
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
      return <p key={i} className="mt-3 font-display font-bold uppercase tracking-wide text-text first:mt-0">{inner}</p>
    }

    // Inline **bold** within a line
    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-text2">
        {parts.map((part, j) =>
          j % 2 === 1 ? <strong key={j} className="font-semibold text-kiwi">{part}</strong> : part
        )}
      </p>
    )
  })
}
