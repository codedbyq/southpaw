import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import CanvasPlayer from '../components/CanvasPlayer'
import StarRating from '../components/StarRating'
import { PlayerSkeleton } from '../components/Skeleton'

export default function PlayerPage() {
  const { clipId } = useParams()
  const navigate = useNavigate()
  const api = useApi()

  const [clip, setClip] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  useEffect(() => {
    async function loadClip() {
      try {
        const [clipData, commentsData, sessionsData] = await Promise.all([
          api.get(`/clips/${clipId}`),
          api.get(`/clips/${clipId}/comments`),
          api.get('/sessions'),
        ])
        setClip(clipData)
        setComments(commentsData)
        setSessions(Array.isArray(sessionsData) ? sessionsData : [])
        setSelectedSession(clipData.session_id || '')

        // A completed coach review of this clip → show rating prompt
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
      const updated = await api.patch(`/clips/${clipId}`, {
        session_id: newSessionId || '',  // empty string = unorganize
      })
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

  function handleTimeClick(t) {
    setCommentTimestamp(t)
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
    <AppLayout active="dashboard">
      <main className="max-w-5xl mx-auto px-8 py-8">
        <PlayerSkeleton />
      </main>
    </AppLayout>
  )

  if (error || !clip) return (
    <AppLayout active="dashboard">
      <div className="flex h-full items-center justify-center">
        <p className="text-danger text-sm">{error || 'Clip not found'}</p>
      </div>
    </AppLayout>
  )

  const isProcessed = clip.job?.status === 'complete'
  const timestampedComments = comments.filter(c => c.timestamp_seconds != null)
  const generalComments = comments.filter(c => c.timestamp_seconds == null)

  return (
    <AppLayout active="dashboard">
      <main className="max-w-5xl mx-auto px-8 py-8 space-y-8">
        {/* Sub-header: back + filename + session picker */}
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate(-1)}
            className="text-muted hover:text-text transition-colors text-sm flex-shrink-0"
          >
            ← Back
          </button>
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <span className="font-display font-bold text-lg text-text truncate">{clip.filename}</span>
            {/* Session picker */}
            <select
              value={selectedSession}
              onChange={e => handleMoveSession(e.target.value)}
              disabled={movingSession}
              className="input w-auto max-w-[200px] truncate py-1 text-xs"
            >
              <option value="">Unorganized</option>
              {sessions.filter(s => s.sport === clip.sport).map(s => (
                <option key={s.id} value={s.id}>
                  {s.label || `${s.session_type || 'Session'}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        <CanvasPlayer
          videoUrl={clip.video_url}
          resultUrl={clip.result_url}
          comments={comments}
          onTimeClick={handleTimeClick}
        />

        {/* Clip notes */}
        <div className="bg-surface border border-line rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-display font-bold text-muted uppercase tracking-wide">What were you working on?</p>
            {!editingNotes && (
              <button
                onClick={() => { setNotesValue(clip.notes || ''); setEditingNotes(true) }}
                className="text-xs text-muted hover:text-text transition-colors"
              >
                {clip.notes ? 'Edit' : '+ Add note'}
              </button>
            )}
          </div>
          {editingNotes ? (
            <div className="space-y-2">
              <textarea
                value={notesValue}
                onChange={e => setNotesValue(e.target.value)}
                placeholder="e.g. Drilling hooks, working on guard after the jab..."
                rows={2}
                autoFocus
                className="input resize-none"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={handleSaveNotes} disabled={savingNotes}>
                  {savingNotes ? 'Saving...' : 'Save'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setEditingNotes(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text3">
              {clip.notes || <span className="text-muted italic">No notes — add context to improve AI feedback</span>}
            </p>
          )}
        </div>

        {/* Comment input */}
        <div className="bg-surface border border-line rounded-2xl p-4">
          <form onSubmit={handleSubmitComment} className="flex flex-col gap-3">
            {commentTimestamp != null && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-gold">
                  📍 {commentTimestamp.toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => setCommentTimestamp(null)}
                  className="text-xs text-muted hover:text-text"
                >
                  × remove timestamp
                </button>
              </div>
            )}
            <div className="flex gap-2">
              <input
                ref={commentInputRef}
                type="text"
                value={commentBody}
                onChange={e => setCommentBody(e.target.value)}
                placeholder={commentTimestamp != null
                  ? `Comment at ${commentTimestamp.toFixed(1)}s...`
                  : 'Add a general comment... or click the timeline to pin to a moment'
                }
                className="input flex-1"
              />
              <Button type="submit" disabled={!commentBody.trim() || submitting}>Post</Button>
            </div>
          </form>
        </div>

        {/* Empty comments state */}
        {comments.length === 0 && (
          <div className="text-center py-6 text-muted text-sm">
            No comments yet — click the timeline to pin feedback to a moment, or type a general note above.
          </div>
        )}

        {/* Timestamped comments */}
        {timestampedComments.length > 0 && (
          <div>
            <h3 className="text-sm font-display font-bold uppercase tracking-wide text-muted mb-3">Timeline comments</h3>
            <div className="flex flex-col gap-2">
              {timestampedComments.map(c => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  onDelete={() => handleDeleteComment(c.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* General comments */}
        {generalComments.length > 0 && (
          <div>
            <h3 className="text-sm font-display font-bold uppercase tracking-wide text-muted mb-3">General comments</h3>
            <div className="flex flex-col gap-2">
              {generalComments.map(c => (
                <CommentRow
                  key={c.id}
                  comment={c}
                  onDelete={() => handleDeleteComment(c.id)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Coach review rating — when a completed review exists for this clip */}
        {review && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5">
            <div>
              <p className="font-display text-sm font-bold uppercase tracking-wide text-text">Coach review</p>
              <p className="mt-0.5 text-xs text-muted">
                {review.coach_display_name || 'Your coach'} reviewed this clip — their timeline comments are above.
              </p>
            </div>
            {review.athlete_rating ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Your rating:</span>
                <StarRating value={review.athlete_rating} readonly size="sm" />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted">Rate this review:</span>
                <StarRating value={null} size="sm" onChange={handleRateReview} />
                {ratingLoading && <span className="text-xs text-muted">Saving...</span>}
              </div>
            )}
          </div>
        )}

        {/* Coaching feedback */}
        {isProcessed && clip.feedback && (
          <div>
            <h2 className="text-lg font-display font-extrabold uppercase tracking-wide text-text mb-4">Coaching feedback</h2>
            <div className="relative overflow-hidden bg-surface border border-line rounded-2xl p-5 text-sm text-text2 leading-relaxed">
              <span className="absolute inset-y-0 left-0 w-[3px] bg-kiwi" />
              <div className="flex items-center gap-2 mb-3 text-[11px] font-bold uppercase tracking-wider text-kiwi">
                <span className="w-1.5 h-1.5 rounded-full bg-kiwi animate-ai-pulse" /> AI Feedback
              </div>
              {renderFeedback(clip.feedback)}
            </div>
          </div>
        )}
        {isProcessed && !clip.feedback && feedbackLoading && (
          <div>
            <h2 className="text-lg font-display font-extrabold uppercase tracking-wide text-text mb-4">Coaching feedback</h2>
            <div className="bg-surface border border-line rounded-2xl p-5 text-sm text-text3 flex items-center gap-3">
              <span className="inline-block w-4 h-4 border-2 border-line2 border-t-kiwi rounded-full animate-spin" />
              Analyzing your technique...
            </div>
          </div>
        )}
      </main>
    </AppLayout>
  )
}


function CommentRow({ comment, onDelete }) {
  return (
    <div className="flex items-start gap-3 p-3 bg-surface border border-line rounded-xl hover:border-gold/60 transition-colors">
      {comment.timestamp_seconds != null && (
        <span className="text-xs text-gold font-display font-bold mt-0.5 flex-shrink-0 tabular-nums">
          {comment.timestamp_seconds.toFixed(1)}s
        </span>
      )}
      <div className="flex-1 min-w-0">
        <span className="text-xs text-muted mr-2">{comment.author_name}</span>
        <span className="text-sm text-text2">{comment.body}</span>
      </div>
      {comment.is_own && (
        <button
          onClick={onDelete}
          className="text-xs text-muted hover:text-danger transition-colors flex-shrink-0"
        >
          delete
        </button>
      )}
    </div>
  )
}


function renderFeedback(text) {
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-2" />
    const isBold = line.startsWith('**') && line.includes('**', 2)
    if (isBold) {
      const inner = line.replace(/^\*\*/, '').replace(/\*\*$/, '')
      return <p key={i} className="font-display font-bold uppercase tracking-wide text-text mt-3 first:mt-0">{inner}</p>
    }
    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-text2">
        {parts.map((part, j) =>
          j % 2 === 1 ? <strong key={j} className="text-kiwi font-semibold">{part}</strong> : part
        )}
      </p>
    )
  })
}
