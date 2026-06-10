import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag, { SportTag, SessionTypeTag } from '../components/Tag'
import CanvasPlayer from '../components/CanvasPlayer'
import StarRating from '../components/StarRating'
import { PlayerSkeleton } from '../components/Skeleton'

// Electric Kiwi strike data-viz ramp (punches lime/green, kicks orange)
const STRIKE_COLORS = {
  jab: '#ccff00', cross: '#dfff00', hook: '#88ff00',
  rear_kick: '#ff9500', roundhouse_kick: '#ff6b00',
}
const STRIKE_LABELS = {
  jab: 'Jab', cross: 'Cross', hook: 'Hook',
  rear_kick: 'Rear kick', roundhouse_kick: 'Roundhouse',
}

function fmtTs(s) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

export default function PlayerPage() {
  const { clipId } = useParams()
  const navigate = useNavigate()
  const api = useApi()
  const playerRef = useRef(null)

  const [clip, setClip] = useState(null)
  const [strikes, setStrikes] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Right panel
  const [activeTab, setActiveTab] = useState('strikes')

  // Comments
  const [comments, setComments] = useState([])
  const [commentBody, setCommentBody] = useState('')
  const [commentTimestamp, setCommentTimestamp] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const commentInputRef = useRef(null)

  // Clip notes edit
  const [editingNotes, setEditingNotes] = useState(false)
  const [notesValue, setNotesValue] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)

  // Move clip to session
  const [sessions, setSessions] = useState([])
  const [movingSession, setMovingSession] = useState(false)
  const [selectedSession, setSelectedSession] = useState('')

  const [feedbackLoading, setFeedbackLoading] = useState(false)

  // Coach review for this clip (athlete rates it here)
  const [review, setReview] = useState(null)
  const [ratingLoading, setRatingLoading] = useState(false)

  // Subject selection (which tracked fighter's metrics to show)
  const [selectedSubject, setSelectedSubject] = useState(null)
  const [subjects, setSubjects] = useState([])
  const [switchingSubject, setSwitchingSubject] = useState(false)

  useEffect(() => {
    async function loadClip() {
      try {
        const [clipData, commentsData, sessionsData, strikesData] = await Promise.all([
          api.get(`/clips/${clipId}`),
          api.get(`/clips/${clipId}/comments`),
          api.get('/sessions'),
          api.get(`/clips/${clipId}/strikes`).catch(() => []),
        ])
        setClip(clipData)
        setComments(commentsData)
        setSessions(Array.isArray(sessionsData) ? sessionsData : [])
        setSelectedSession(clipData.session_id || '')
        setStrikes(Array.isArray(strikesData) ? strikesData : [])
        setSelectedSubject(clipData.selected_subject_id ?? null)

        try {
          const myReviews = await api.get('/reviews/me/athlete')
          const match = (Array.isArray(myReviews) ? myReviews : [])
            .find(r => r.clip_id === clipId && r.status === 'complete')
          if (match) setReview(match)
        } catch {}
      } catch (err) {
        setError('Failed to load clip')
      } finally {
        setLoading(false)
      }
    }
    loadClip()
  }, [clipId])

  async function handleRateReview(rating) {
    if (!review) return
    setRatingLoading(true)
    try {
      const updated = await api.patch(`/reviews/${review.id}/rate`, { rating })
      setReview(updated)
    } catch (err) {
      console.error('Failed to rate review', err)
    } finally {
      setRatingLoading(false)
    }
  }

  // Poll for feedback when clip is processed but feedback hasn't arrived yet
  useEffect(() => {
    if (!clip || clip.feedback || clip.status !== 'processed') return
    setFeedbackLoading(true)
    let cancelled = false
    const interval = setInterval(async () => {
      try {
        const data = await api.get(`/clips/${clipId}`)
        if (!cancelled && data.feedback) {
          setClip(prev => ({ ...prev, feedback: data.feedback }))
          setFeedbackLoading(false)
          clearInterval(interval)
        }
      } catch {}
    }, 4000)
    const timeout = setTimeout(() => {
      clearInterval(interval)
      if (!cancelled) setFeedbackLoading(false)
    }, 120000)
    return () => { cancelled = true; clearInterval(interval); clearTimeout(timeout) }
  }, [clip?.status, clip?.feedback, clipId])

  async function handleMoveSession(newSessionId) {
    setMovingSession(true)
    try {
      const updated = await api.patch(`/clips/${clipId}`, { session_id: newSessionId || '' })
      setClip(updated)
      setSelectedSession(updated.session_id || '')
    } catch (err) {
      console.error('Failed to move clip', err)
    } finally {
      setMovingSession(false)
    }
  }

  async function handleSaveNotes() {
    setSavingNotes(true)
    try {
      const updated = await api.patch(`/clips/${clipId}`, { notes: notesValue || null })
      setClip(updated)
      setEditingNotes(false)
    } catch (err) {
      console.error('Failed to save notes', err)
    } finally {
      setSavingNotes(false)
    }
  }

  function seek(t) {
    playerRef.current?.seekTo(t)
  }

  async function handleSelectSubject(id) {
    if (id == null || id === selectedSubject || switchingSubject) return
    setSwitchingSubject(true)
    try {
      const updatedClip = await api.post(`/clips/${clipId}/select-subject`, { subject_id: id })
      const freshStrikes = await api.get(`/clips/${clipId}/strikes`).catch(() => [])
      setClip(updatedClip)
      setStrikes(Array.isArray(freshStrikes) ? freshStrikes : [])
      setSelectedSubject(id)
    } catch (err) {
      console.error('Failed to switch subject', err)
    } finally {
      setSwitchingSubject(false)
    }
  }

  function handleTimeClick(t) {
    setCommentTimestamp(t)
    setActiveTab('comments')
    commentInputRef.current?.focus()
  }

  async function handleSubmitComment(e) {
    e.preventDefault()
    if (!commentBody.trim()) return
    setSubmitting(true)
    try {
      const newComment = await api.post(`/clips/${clipId}/comments`, {
        body: commentBody.trim(),
        timestamp_seconds: commentTimestamp,
      })
      setComments(prev => [...prev, newComment])
      setCommentBody('')
      setCommentTimestamp(null)
    } catch (err) {
      console.error('Failed to post comment', err)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteComment(commentId) {
    try {
      await api.delete(`/clips/${clipId}/comments/${commentId}`)
      setComments(prev => prev.filter(c => c.id !== commentId))
    } catch (err) {
      console.error('Failed to delete comment', err)
    }
  }

  if (loading) return (
    <AppLayout active="clips">
      <main className="mx-auto max-w-5xl px-8 py-8"><PlayerSkeleton /></main>
    </AppLayout>
  )

  if (error || !clip) return (
    <AppLayout active="clips">
      <div className="flex h-full items-center justify-center"><p className="text-sm text-danger">{error || 'Clip not found'}</p></div>
    </AppLayout>
  )

  // ── Derived metrics from strikes ──
  const totalStrikes = strikes.length
  const dur = clip.duration_seconds
  const spm = dur ? totalStrikes / (dur / 60) : null
  const guardMeasured = strikes.filter(s => s.guard_dropped != null)
  const guardDrop = guardMeasured.length ? guardMeasured.filter(s => s.guard_dropped).length / guardMeasured.length : null
  const exts = strikes.filter(s => s.arm_extension != null).map(s => s.arm_extension)
  const avgExt = exts.length ? exts.reduce((a, b) => a + b, 0) / exts.length : null
  const guardPct = guardDrop != null ? Math.round(guardDrop * 100) : null

  const typeCounts = {}
  strikes.forEach(s => { typeCounts[s.type] = (typeCounts[s.type] || 0) + 1 })
  const maxTypeCount = Math.max(1, ...Object.values(typeCounts))
  const byType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])

  const backTo = clip.session_id ? `/sessions/${clip.session_id}` : '/clips'

  return (
    <AppLayout active="clips">
      <div className="flex h-full flex-col xl:flex-row xl:overflow-hidden">

        {/* ── LEFT: clip info + metrics + AI ── */}
        <aside className="flex flex-shrink-0 flex-col border-line xl:w-[280px] xl:overflow-y-auto xl:border-r">
          <div className="border-b border-line p-5">
            <button onClick={() => navigate(backTo)} className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-text">
              ← Back
            </button>
            <h1 className="font-display text-[22px] font-extrabold leading-tight text-text">{clip.filename}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <SportTag sport={clip.sport} />
              {dur != null && <Tag tone="muted">{fmtTs(dur)}</Tag>}
            </div>

            {/* Clip note */}
            <div className="mt-3">
              {editingNotes ? (
                <div className="space-y-2">
                  <textarea value={notesValue} onChange={e => setNotesValue(e.target.value)}
                    placeholder="What were you working on?" rows={2} autoFocus className="input resize-none text-xs" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleSaveNotes} disabled={savingNotes}>{savingNotes ? 'Saving...' : 'Save'}</Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditingNotes(false)}>Cancel</Button>
                  </div>
                </div>
              ) : clip.notes ? (
                <div className="group rounded-lg border-l-2 border-line2 bg-surface2 p-2.5">
                  <p className="text-xs italic leading-relaxed text-text3">"{clip.notes}"</p>
                  <button onClick={() => { setNotesValue(clip.notes); setEditingNotes(true) }} className="mt-1 text-[10px] uppercase tracking-wide text-muted hover:text-kiwi">Edit note</button>
                </div>
              ) : (
                <button onClick={() => { setNotesValue(''); setEditingNotes(true) }} className="text-xs text-muted hover:text-kiwi">+ Add note for the AI</button>
              )}
            </div>
          </div>

          {/* Subject selector — only when ByteTrack found more than one person */}
          {subjects.length > 1 && (
            <div className="border-b border-line p-5">
              <SectionLabel>
                Fighter{switchingSubject && <span className="ml-1.5 text-muted">· updating…</span>}
              </SectionLabel>
              <div className="flex flex-wrap gap-2">
                {subjects.map((s, i) => (
                  <button key={s.id} onClick={() => handleSelectSubject(s.id)} disabled={switchingSubject}
                    className={`chip ${selectedSubject === s.id ? 'active' : ''} disabled:opacity-50`}>
                    Fighter {i + 1}{s.strikes != null ? ` · ${s.strikes}` : ''}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">
                Pick whose metrics to show — background people and the opponent are excluded.
              </p>
            </div>
          )}

          {/* Metrics */}
          <div className="flex-1 p-5">
            <SectionLabel>This clip</SectionLabel>
            <MetricRow name="Total strikes" value={totalStrikes} />
            <MetricRow name="Strikes / min" value={spm != null ? spm.toFixed(1) : '—'} />
            <MetricRow name="Avg arm extension" value={avgExt != null ? avgExt.toFixed(2) : '—'} color={avgExt != null ? 'text-kiwi' : 'text-text'} />
            <MetricRow name="Guard drop rate" value={guardPct != null ? `${guardPct}%` : '—'}
              color={guardPct == null ? 'text-text' : guardPct > 50 ? 'text-danger' : guardPct > 35 ? 'text-warning' : 'text-kiwi'} />
            <MetricRow name="Head movement" value={clip.head_movement_score != null ? clip.head_movement_score.toFixed(2) : '—'} last />

            {byType.length > 0 && (
              <>
                <SectionLabel className="mt-6">By strike type</SectionLabel>
                {byType.map(([type, count]) => (
                  <div key={type} className="mb-2">
                    <div className="mb-1 flex justify-between">
                      <span className="text-xs text-text3">{STRIKE_LABELS[type] || type.replace('_', ' ')}</span>
                      <span className="font-display text-sm font-bold tabular-nums text-text">{count}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface3">
                      <div className="h-full rounded-full transition-all duration-[600ms]" style={{ width: `${(count / maxTypeCount) * 100}%`, background: STRIKE_COLORS[type] || '#ccff00' }} />
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* AI feedback */}
          {(clip.feedback || feedbackLoading) && (
            <div className="m-4 mt-0 rounded-r-xl border-l-[3px] border-l-kiwi bg-surface2 p-4">
              <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-kiwi">
                <span className="h-1.5 w-1.5 rounded-full bg-kiwi animate-ai-pulse" /> AI feedback
              </div>
              {clip.feedback ? (
                <div className="text-[13px] leading-relaxed text-text2">{renderFeedback(clip.feedback)}</div>
              ) : (
                <p className="flex items-center gap-2 text-xs text-text3">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line2 border-t-kiwi" /> Analyzing your technique...
                </p>
              )}
            </div>
          )}
        </aside>

        {/* ── CENTER: video ── */}
        <div className="flex min-w-0 flex-1 flex-col bg-ink p-4 md:p-6">
          <div className="mb-3 flex items-center gap-3">
            <span className="hidden font-display text-sm text-text3 xl:block">Session:</span>
            <select value={selectedSession} onChange={e => handleMoveSession(e.target.value)} disabled={movingSession}
              className="input w-auto max-w-[220px] truncate py-1 text-xs">
              <option value="">Unorganized</option>
              {sessions.filter(s => s.sport === clip.sport).map(s => (
                <option key={s.id} value={s.id}>{s.label || `${s.session_type || 'Session'}`}</option>
              ))}
            </select>
          </div>
          <CanvasPlayer
            ref={playerRef}
            videoUrl={clip.video_url}
            resultUrl={clip.result_url}
            comments={comments}
            onTimeClick={handleTimeClick}
            selectedSubject={selectedSubject}
            onSelectSubject={handleSelectSubject}
            onSubjects={setSubjects}
          />
        </div>

        {/* ── RIGHT: strikes / comments ── */}
        <aside className="flex flex-shrink-0 flex-col border-line xl:w-[300px] xl:overflow-hidden xl:border-l">
          {/* Tabs */}
          <div className="flex flex-shrink-0 border-b border-line">
            {[['strikes', `Strikes (${totalStrikes})`], ['comments', `Coach (${comments.length})`]].map(([t, label]) => (
              <button key={t} onClick={() => setActiveTab(t)}
                className={`flex-1 border-b-2 py-3.5 font-display text-[13px] font-bold uppercase tracking-wide transition-colors ${
                  activeTab === t ? 'border-kiwi text-kiwi' : 'border-transparent text-muted hover:text-text'
                }`}>
                {label}
              </button>
            ))}
          </div>

          <div className="flex-1 p-4 xl:overflow-y-auto">
            {/* STRIKES */}
            {activeTab === 'strikes' && (
              strikes.length === 0 ? (
                <p className="py-8 text-center text-xs text-muted">No strikes detected yet.</p>
              ) : strikes.map(s => (
                <button key={s.id} onClick={() => seek(s.timestamp_seconds)}
                  className="group flex w-full items-center gap-2.5 border-b border-line py-2.5 text-left last:border-0">
                  <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: STRIKE_COLORS[s.type] || '#ccff00' }} />
                  <span className="w-9 flex-shrink-0 font-display text-[15px] font-bold tabular-nums text-muted group-hover:text-kiwi">{fmtTs(s.timestamp_seconds)}</span>
                  <span className="flex-1 text-[13px] text-text">{STRIKE_LABELS[s.type] || s.type.replace('_', ' ')}</span>
                  {s.guard_dropped && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-danger">G↓</span>}
                  {s.arm_extension != null && <span className="font-display text-sm font-bold tabular-nums text-muted">{s.arm_extension.toFixed(2)}</span>}
                </button>
              ))
            )}

            {/* COMMENTS */}
            {activeTab === 'comments' && (
              <div className="space-y-3">
                {/* Input */}
                <form onSubmit={handleSubmitComment} className="space-y-2">
                  {commentTimestamp != null && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-gold">📍 {commentTimestamp.toFixed(1)}s</span>
                      <button type="button" onClick={() => setCommentTimestamp(null)} className="text-muted hover:text-text">× remove</button>
                    </div>
                  )}
                  <input ref={commentInputRef} type="text" value={commentBody} onChange={e => setCommentBody(e.target.value)}
                    placeholder={commentTimestamp != null ? `Comment at ${commentTimestamp.toFixed(1)}s...` : 'Add a comment — or click the timeline'}
                    className="input text-sm" />
                  <Button type="submit" size="sm" className="w-full" disabled={!commentBody.trim() || submitting}>Post comment</Button>
                </form>

                {comments.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted">No comments yet. Click the timeline to pin feedback to a moment.</p>
                ) : comments.map(c => (
                  <div key={c.id}
                    onClick={() => c.timestamp_seconds != null && seek(c.timestamp_seconds)}
                    className={`rounded-xl border border-line bg-surface2 p-3 transition-colors hover:border-gold/60 ${c.timestamp_seconds != null ? 'cursor-pointer' : ''}`}>
                    {c.timestamp_seconds != null && (
                      <div className="mb-1.5 inline-flex items-center gap-1.5 font-display text-[13px] font-bold text-gold">
                        <span className="h-1.5 w-1.5 rounded-full bg-gold" /> {fmtTs(c.timestamp_seconds)}
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] font-semibold text-muted">{c.author_name}</p>
                      {c.is_own && (
                        <button onClick={e => { e.stopPropagation(); handleDeleteComment(c.id) }} className="text-[10px] text-muted hover:text-danger">delete</button>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] leading-relaxed text-text2">{c.body}</p>
                  </div>
                ))}

                {/* Review rating */}
                {review && (
                  <div className="rounded-xl border border-line bg-surface2 p-3">
                    <p className="font-display text-xs font-bold uppercase tracking-wide text-text">Coach review</p>
                    {review.athlete_rating ? (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-muted">Your rating:</span>
                        <StarRating value={review.athlete_rating} readonly size="sm" />
                      </div>
                    ) : (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-muted">Rate it:</span>
                        <StarRating value={null} size="sm" onChange={handleRateReview} />
                        {ratingLoading && <span className="text-xs text-muted">...</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Request review */}
          <div className="flex-shrink-0 border-t border-line p-4">
            <Button className="w-full rounded-xl" onClick={() => navigate('/coaches')}>Request coach review →</Button>
          </div>
        </aside>
      </div>
    </AppLayout>
  )
}

function SectionLabel({ children, className = '' }) {
  return <p className={`mb-2.5 text-[10px] font-bold uppercase tracking-wider text-muted ${className}`}>{children}</p>
}

function MetricRow({ name, value, color = 'text-text', last = false }) {
  return (
    <div className={`flex items-center justify-between py-2 ${last ? '' : 'border-b border-line'}`}>
      <span className="text-[13px] text-text3">{name}</span>
      <span className={`font-display text-xl font-extrabold tabular-nums ${color}`}>{value}</span>
    </div>
  )
}

function renderFeedback(text) {
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-1.5" />
    const isBold = line.startsWith('**') && line.includes('**', 2)
    if (isBold) {
      const inner = line.replace(/^\*\*/, '').replace(/\*\*$/, '')
      return <p key={i} className="mt-2 font-display font-bold uppercase tracking-wide text-text first:mt-0">{inner}</p>
    }
    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-text2">
        {parts.map((part, j) => j % 2 === 1 ? <strong key={j} className="font-semibold text-kiwi">{part}</strong> : part)}
      </p>
    )
  })
}
