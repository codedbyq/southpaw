import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag, { SportTag, SessionTypeTag } from '../components/Tag'
import UploadButton from '../components/UploadButton'
import { SessionDetailSkeleton } from '../components/Skeleton'

const SPORT_LABELS = { boxing: 'Boxing', muay_thai: 'Muay Thai', mma: 'MMA' }
const SESSION_TYPE_LABELS = { sparring: 'Sparring', bag: 'Bag work', pads: 'Pads', shadow: 'Shadow boxing' }
const SPORT_EMOJI = { boxing: '🥊', muay_thai: '🦵', mma: '🤼' }

function fmtDuration(secs) {
  if (!secs) return null
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function guardColor(pct) {
  if (pct > 50) return 'var(--color-danger)'
  if (pct > 35) return 'var(--color-warning)'
  return 'var(--color-kiwi)'
}

export default function SessionPage() {
  const { sessionId } = useParams()
  const navigate = useNavigate()
  const api = useApi()

  const [session, setSession] = useState(null)
  const [analytics, setAnalytics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [activeTab, setActiveTab] = useState('clips')

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
    const { clip_count } = await api.get(`/sessions/${sessionId}/clip-count`).catch(() => ({ clip_count: 0 }))
    const clipMsg = clip_count > 0
      ? `${clip_count} clip${clip_count !== 1 ? 's' : ''} will be moved to your unorganized clips.`
      : 'This session has no clips.'
    if (!confirm(`Delete this session?\n\n${clipMsg}\n\nSession analytics and feedback will be archived.`)) return
    setDeleting(true)
    try {
      await api.delete(`/sessions/${sessionId}`)
      navigate('/sessions')
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

  useEffect(() => { loadSession() }, [sessionId])

  if (loading) {
    return (
      <AppLayout active="sessions">
        <main className="mx-auto max-w-5xl px-4 py-10 md:px-8"><SessionDetailSkeleton /></main>
      </AppLayout>
    )
  }
  if (notFound) {
    return (
      <AppLayout active="sessions">
        <main className="px-8 py-10"><p className="text-sm text-muted">Session not found.</p></main>
      </AppLayout>
    )
  }

  const m = session.metrics
  const clipMetrics = session.clip_metrics || {}
  const totalDuration = session.clips.reduce((sum, c) => sum + (c.duration_seconds || 0), 0)
  const guardPct = m.guard_drop_rate != null ? Math.round(m.guard_drop_rate * 100) : null

  return (
    <AppLayout active="sessions">
      {/* ── Hero ── */}
      <div className="border-b border-line bg-surface px-4 py-7 md:px-8">
        <button
          onClick={() => navigate('/sessions')}
          className="mb-4 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-text"
        >
          ← Sessions
        </button>

        {editing ? (
          <EditForm
            {...{ editLabel, setEditLabel, editSport, setEditSport, editType, setEditType,
              editTrainingPhase, setEditTrainingPhase, editOpponentContext, setEditOpponentContext,
              editNotes, setEditNotes, saving, handleSave }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="font-display text-[34px] font-black leading-none tracking-tight text-text md:text-[38px]">
                  {session.label || 'Untitled session'}
                </h1>
                <p className="mt-2 text-sm text-text3">
                  {new Date(session.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  {` · ${session.clips.length} clip${session.clips.length !== 1 ? 's' : ''}`}
                  {fmtDuration(totalDuration) ? ` · ${fmtDuration(totalDuration)} total` : ''}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-2">
                <Button variant="secondary" size="sm" onClick={startEdit}>Edit</Button>
                <UploadButton onUploadComplete={loadSession} />
                <Button variant="danger" size="sm" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              </div>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <SportTag sport={session.sport} />
              <SessionTypeTag type={session.session_type} />
              <Tag tone="pads">{session.clips.length} clips</Tag>
              {session.training_phase && <Tag tone="muted">{session.training_phase.replace('_', ' ')}</Tag>}
            </div>
            {session.notes && <p className="mt-3 max-w-2xl text-sm text-text3">{session.notes}</p>}
            {session.opponent_context && <p className="mt-1 text-xs text-muted">Opponent: {session.opponent_context}</p>}
          </>
        )}
      </div>

      {/* ── 4 metric tiles ── */}
      <div className="grid grid-cols-2 gap-3 border-b border-line px-4 py-6 md:grid-cols-4 md:px-8">
        <MetricTile label="Total strikes" value={m.total_strikes?.toLocaleString() ?? '—'} border="hi" valueColor="text-kiwi"
          sub={`across ${session.clips.length} clip${session.clips.length !== 1 ? 's' : ''}`} />
        <MetricTile label="Strikes / min" value={m.strikes_per_minute != null ? m.strikes_per_minute.toFixed(1) : '—'}
          sub="per minute" />
        <MetricTile label="Guard drop rate"
          value={guardPct != null ? guardPct : '—'} unit={guardPct != null ? '%' : ''}
          border={guardPct != null && guardPct > 35 ? 'warn' : undefined}
          valueColor={guardPct == null ? 'text-text' : guardPct > 50 ? 'text-danger' : guardPct > 35 ? 'text-warning' : 'text-kiwi'}
          sub="lower is better" />
        <MetricTile label="Avg arm extension" value={m.avg_arm_extension != null ? m.avg_arm_extension.toFixed(2) : '—'}
          sub="higher is better" />
      </div>

      {/* ── Body: main + aside ── */}
      <div className="flex flex-col xl:flex-row">
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
          {/* AI session analysis */}
          <div className="relative mb-6 overflow-hidden rounded-r-2xl border border-l-[3px] border-line border-l-kiwi bg-surface p-5">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-kiwi">
                <span className="h-1.5 w-1.5 rounded-full bg-kiwi animate-ai-pulse" /> Session analysis
              </div>
              {session.clips.length >= 2 && (!feedback || feedbackDirty) && (
                <Button size="sm" variant={feedbackDirty && feedback ? 'secondary' : 'primary'} onClick={fetchFeedback} disabled={feedbackLoading}>
                  {feedbackLoading ? 'Analysing...' : feedbackDirty && feedback ? '↺ Re-analyse' : 'Analyse session'}
                </Button>
              )}
            </div>
            {session.clips.length < 2 ? (
              <p className="text-sm italic text-muted">Add at least 2 clips to unlock session analysis.</p>
            ) : feedbackLoading ? (
              <p className="animate-pulse text-sm text-muted">Analysing your session data...</p>
            ) : feedbackError ? (
              <p className="text-sm text-danger">{feedbackError}</p>
            ) : feedback ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-text2">{renderFeedback(feedback)}</div>
            ) : (
              <p className="text-sm text-muted">Click "Analyse session" to generate AI coaching notes across all clips.</p>
            )}
          </div>

          {/* Tabs */}
          <div className="mb-4 flex border-b border-line">
            {['clips', 'analytics'].map(t => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`-mb-px border-b-2 px-5 py-2.5 font-display text-sm font-bold uppercase tracking-wide transition-colors ${
                  activeTab === t ? 'border-kiwi text-kiwi' : 'border-transparent text-muted hover:text-text'
                }`}
              >
                {t === 'clips' ? `Clips (${session.clips.length})` : 'Analytics'}
              </button>
            ))}
          </div>

          {/* Clips tab */}
          {activeTab === 'clips' && (
            session.clips.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-line py-10 text-center">
                <p className="mb-1 text-sm text-muted">No clips in this session yet.</p>
                <p className="text-xs text-muted">Upload a clip and assign it here to get started.</p>
              </div>
            ) : (
              <div>
                {session.clips.map(clip => (
                  <ClipRow key={clip.id} clip={clip} metrics={clipMetrics[clip.id]} onClick={() => navigate(`/clips/${clip.id}`)} />
                ))}
              </div>
            )
          )}

          {/* Analytics tab */}
          {activeTab === 'analytics' && (
            <div className="space-y-8">
              {/* Fatigue curve */}
              {analytics?.fatigue_curve?.length > 0 && (
                <div>
                  <SecTitle>Fatigue curve — arm extension</SecTitle>
                  <div className="flex gap-3">
                    {analytics.fatigue_curve.map((t, i) => {
                      const ext = t.avg_arm_extension
                      const h = ext != null ? Math.round(ext * 100) : 0
                      const color = i === 0 ? 'var(--color-kiwi)' : i === 1 ? 'var(--color-gold)' : 'var(--color-warning)'
                      return (
                        <div key={t.third} className="flex-1">
                          <div className="mb-1.5 flex h-20 items-end overflow-hidden rounded-lg bg-surface2">
                            <div className="w-full rounded-t-md transition-all duration-[600ms]" style={{ height: `${h}%`, background: color }} />
                          </div>
                          <div className="text-center font-display text-base font-extrabold tabular-nums" style={{ color }}>
                            {ext != null ? ext.toFixed(2) : '—'}
                          </div>
                          <div className="mt-0.5 text-center text-[10px] font-semibold uppercase tracking-wide text-muted">
                            {['1st', '2nd', 'Final'][i] || `T${t.third}`} third
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Guard by strike type */}
              {analytics?.guard_by_type?.length > 0 && (
                <div>
                  <SecTitle>Guard drop by strike type</SecTitle>
                  <GuardBars data={analytics.guard_by_type} />
                </div>
              )}

              {!analytics?.fatigue_curve?.length && !analytics?.guard_by_type?.length && (
                <p className="text-sm text-muted">Analytics appear once clips finish processing.</p>
              )}
            </div>
          )}
        </main>

        {/* Aside */}
        <aside className="border-t border-line px-4 py-6 md:px-8 xl:w-[340px] xl:flex-shrink-0 xl:border-l xl:border-t-0">
          {/* Top combos */}
          <SecTitle>Top combos</SecTitle>
          {analytics?.combos?.top_sequences?.length > 0 ? (
            <div className="mb-8">
              {analytics.combos.top_sequences.map((c, i) => (
                <div key={i} className="flex items-center gap-3 border-b border-line py-2.5 last:border-0">
                  <span className="w-5 flex-shrink-0 font-display text-lg font-black text-muted">{i + 1}</span>
                  <span className="flex-1 text-sm text-text">{c.sequence.map(s => s.replace('_', ' ')).join(' → ')}</span>
                  <span className="font-display text-base font-extrabold tabular-nums text-kiwi">×{c.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-8 text-sm text-muted">No combos detected yet.</p>
          )}

          {/* Guard by strike */}
          <SecTitle>Guard drop by strike</SecTitle>
          {analytics?.guard_by_type?.length > 0 ? (
            <div className="mb-8"><GuardBars data={analytics.guard_by_type} compact /></div>
          ) : (
            <p className="mb-8 text-sm text-muted">No data yet.</p>
          )}

          {/* Request session review */}
          <SecTitle>Get coach feedback</SecTitle>
          <div className="rounded-2xl border border-line bg-surface2 p-4">
            <p className="mb-3 text-sm leading-relaxed text-text3">
              Request a full session review from a verified coach — they'll leave timestamped comments across every clip.
            </p>
            <Button className="w-full rounded-xl" onClick={() => navigate('/coaches')}>
              Request session review →
            </Button>
          </div>
        </aside>
      </div>
    </AppLayout>
  )
}

function SecTitle({ children }) {
  return <h3 className="mb-4 font-display text-sm font-extrabold uppercase tracking-wider text-text3">{children}</h3>
}

function MetricTile({ label, value, unit, sub, border, valueColor = 'text-text' }) {
  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-surface p-5 ${
      border === 'hi' ? 'border-kiwi' : border === 'warn' ? 'border-warning' : 'border-line'
    }`}>
      {border === 'hi' && <span className="absolute inset-x-0 top-0 h-0.5 bg-kiwi" />}
      {border === 'warn' && <span className="absolute inset-x-0 top-0 h-0.5 bg-warning" />}
      <p className="mb-2 text-[10px] font-bold uppercase tracking-wider text-muted">{label}</p>
      <p className={`font-display text-[34px] font-black leading-none tracking-tight tabular-nums md:text-[42px] ${valueColor}`}>
        {value}{unit && <span className="ml-0.5 font-display text-base font-semibold text-muted">{unit}</span>}
      </p>
      {sub && <p className="mt-1.5 text-[11px] text-muted">{sub}</p>}
    </div>
  )
}

function ClipRow({ clip, metrics, onClick }) {
  const ready = (clip.job?.status || clip.status) === 'complete'
  const dur = fmtDuration(clip.duration_seconds)
  const guard = metrics?.guard_drop_rate != null ? Math.round(metrics.guard_drop_rate * 100) : null
  return (
    <div onClick={onClick} className="group flex cursor-pointer items-center gap-4 border-b border-line py-3.5 last:border-0">
      <div className="relative flex h-14 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line2 bg-surface2 text-2xl">
        {clip.thumbnail_url ? <img src={clip.thumbnail_url} alt="" className="h-full w-full object-cover" /> : (SPORT_EMOJI[clip.sport] || '🎬')}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="text-base text-white">▶</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-[17px] font-extrabold text-text">{clip.filename}</p>
        <div className="mt-1 flex items-center gap-2">
          {dur && <span className="text-xs text-text3">{dur}</span>}
          {ready
            ? metrics && <Tag tone="muted">{metrics.total_strikes} strikes</Tag>
            : <Tag tone="warning">Processing</Tag>}
        </div>
      </div>
      {ready && metrics && (
        <div className="flex flex-shrink-0 items-center gap-5">
          <ClipMini value={metrics.strikes_per_minute != null ? metrics.strikes_per_minute.toFixed(1) : '—'} label="/ min" />
          <ClipMini value={guard != null ? `${guard}%` : '—'} label="Guard"
            color={guard == null ? 'text-text' : guard < 35 ? 'text-kiwi' : guard > 50 ? 'text-danger' : 'text-warning'} />
          <ClipMini value={metrics.avg_arm_extension != null ? metrics.avg_arm_extension.toFixed(2) : '—'} label="Ext" />
        </div>
      )}
      <span className="hidden flex-shrink-0 text-xl text-muted transition-colors group-hover:text-kiwi sm:block">›</span>
    </div>
  )
}

function ClipMini({ value, label, color = 'text-text' }) {
  return (
    <div className="text-right">
      <p className={`font-display text-xl font-extrabold leading-none tabular-nums ${color}`}>{value}</p>
      <p className="mt-1 text-[9px] font-bold uppercase tracking-wide text-muted">{label}</p>
    </div>
  )
}

function GuardBars({ data, compact = false }) {
  return (
    <div>
      {data.map(g => (
        <div key={g.type} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
          <span className={`flex-shrink-0 text-[13px] capitalize text-text3 ${compact ? 'w-16' : 'w-20'}`}>{g.type.replace('_', ' ')}</span>
          <div className="h-[5px] flex-1 overflow-hidden rounded-full bg-surface3">
            <div className="h-full rounded-full transition-all duration-[600ms]" style={{ width: `${g.guard_drop_pct}%`, background: guardColor(g.guard_drop_pct) }} />
          </div>
          <span className="w-9 text-right font-display text-sm font-extrabold tabular-nums" style={{ color: guardColor(g.guard_drop_pct) }}>{g.guard_drop_pct}%</span>
        </div>
      ))}
    </div>
  )
}

function EditForm({
  editLabel, setEditLabel, editSport, setEditSport, editType, setEditType,
  editTrainingPhase, setEditTrainingPhase, editOpponentContext, setEditOpponentContext,
  editNotes, setEditNotes, saving, handleSave, onCancel,
}) {
  return (
    <div className="space-y-3">
      <input type="text" value={editLabel} onChange={e => setEditLabel(e.target.value)} placeholder="Session label (optional)" className="input" />
      <div className="flex gap-3">
        <select value={editSport} onChange={e => setEditSport(e.target.value)} className="input w-auto">
          {Object.entries(SPORT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={editType} onChange={e => setEditType(e.target.value)} className="input w-auto">
          <option value="">No type</option>
          {Object.entries(SESSION_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select value={editTrainingPhase} onChange={e => setEditTrainingPhase(e.target.value)} className="input w-auto">
          <option value="">Training phase (optional)</option>
          <option value="regular">Regular training</option>
          <option value="fight_camp">Fight camp</option>
          <option value="off_season">Off season</option>
          <option value="recovery">Recovery</option>
        </select>
      </div>
      <input type="text" value={editOpponentContext} onChange={e => setEditOpponentContext(e.target.value)}
        placeholder="Opponent context — e.g. taller southpaw with strong clinch..." className="input" />
      <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} rows={2}
        placeholder="Session notes — context for the AI and coaches..." className="input resize-none" />
      <div className="flex gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
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
    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-text2">
        {parts.map((part, j) => j % 2 === 1 ? <strong key={j} className="font-semibold text-kiwi">{part}</strong> : part)}
      </p>
    )
  })
}
