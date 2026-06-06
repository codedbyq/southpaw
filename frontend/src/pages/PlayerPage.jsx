import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import CanvasPlayer from '../components/CanvasPlayer'
import NotificationBell from '../components/NotificationBell'
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
      } catch (err) {
        setError('Failed to load clip')
      } finally {
        setLoading(false)
      }
    }
    loadClip()
  }, [clipId])

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
    <div className="min-h-screen bg-gray-950">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <div className="w-12 h-4 bg-gray-800 animate-pulse rounded" />
        <div className="flex-1 h-4 bg-gray-800 animate-pulse rounded max-w-xs" />
      </nav>
      <main className="max-w-5xl mx-auto px-6 py-8">
        <PlayerSkeleton />
      </main>
    </div>
  )

  if (error || !clip) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-red-400 text-sm">{error || 'Clip not found'}</p>
    </div>
  )

  const isProcessed = clip.job?.status === 'complete'
  const timestampedComments = comments.filter(c => c.timestamp_seconds != null)
  const generalComments = comments.filter(c => c.timestamp_seconds == null)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-white transition-colors text-sm flex-shrink-0"
        >
          ← Back
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="font-medium text-sm text-gray-300 truncate">{clip.filename}</span>
          {/* Session picker */}
          <select
            value={selectedSession}
            onChange={e => handleMoveSession(e.target.value)}
            disabled={movingSession}
            className="text-xs px-2.5 py-1 bg-gray-800 border border-gray-700 text-gray-400 rounded-lg focus:outline-none focus:border-indigo-500 disabled:opacity-50 max-w-[200px] truncate"
          >
            <option value="">Unorganized</option>
            {sessions.filter(s => s.sport === clip.sport).map(s => (
              <option key={s.id} value={s.id}>
                {s.label || `${s.session_type || 'Session'}`}
              </option>
            ))}
          </select>
        </div>
        <NotificationBell />
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        <CanvasPlayer
          videoUrl={clip.video_url}
          resultUrl={clip.result_url}
          comments={comments}
          onTimeClick={handleTimeClick}
        />

        {/* Clip notes */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium text-gray-400 uppercase tracking-wide">What were you working on?</p>
            {!editingNotes && (
              <button
                onClick={() => { setNotesValue(clip.notes || ''); setEditingNotes(true) }}
                className="text-xs text-gray-500 hover:text-white transition-colors"
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
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
              />
              <div className="flex gap-2">
                <button onClick={handleSaveNotes} disabled={savingNotes}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs rounded-lg transition-colors">
                  {savingNotes ? 'Saving...' : 'Save'}
                </button>
                <button onClick={() => setEditingNotes(false)}
                  className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-xs rounded-lg transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400">
              {clip.notes || <span className="text-gray-600 italic">No notes — add context to improve AI feedback</span>}
            </p>
          )}
        </div>

        {/* Comment input */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <form onSubmit={handleSubmitComment} className="flex flex-col gap-3">
            {commentTimestamp != null && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-yellow-400">
                  📍 {commentTimestamp.toFixed(1)}s
                </span>
                <button
                  type="button"
                  onClick={() => setCommentTimestamp(null)}
                  className="text-xs text-gray-500 hover:text-white"
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
                className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={!commentBody.trim() || submitting}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Post
              </button>
            </div>
          </form>
        </div>

        {/* Empty comments state */}
        {comments.length === 0 && (
          <div className="text-center py-6 text-gray-600 text-sm">
            No comments yet — click the timeline to pin feedback to a moment, or type a general note above.
          </div>
        )}

        {/* Timestamped comments */}
        {timestampedComments.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3">Timeline comments</h3>
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
            <h3 className="text-sm font-medium text-gray-400 mb-3">General comments</h3>
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

        {/* Coaching feedback */}
        {isProcessed && clip.feedback && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Coaching feedback</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-300 leading-relaxed">
              {renderFeedback(clip.feedback)}
            </div>
          </div>
        )}
        {isProcessed && !clip.feedback && feedbackLoading && (
          <div>
            <h2 className="text-lg font-semibold mb-4">Coaching feedback</h2>
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-400 flex items-center gap-3">
              <span className="inline-block w-4 h-4 border-2 border-gray-600 border-t-yellow-400 rounded-full animate-spin" />
              Analyzing your technique...
            </div>
          </div>
        )}
      </main>
    </div>
  )
}


function CommentRow({ comment, onDelete }) {
  return (
    <div className="flex items-start gap-3 p-3 bg-gray-900 border border-gray-800 rounded-lg">
      {comment.timestamp_seconds != null && (
        <span className="text-xs text-yellow-400 font-mono mt-0.5 flex-shrink-0">
          {comment.timestamp_seconds.toFixed(1)}s
        </span>
      )}
      <div className="flex-1 min-w-0">
        <span className="text-xs text-gray-500 mr-2">{comment.author_name}</span>
        <span className="text-sm text-gray-300">{comment.body}</span>
      </div>
      {comment.is_own && (
        <button
          onClick={onDelete}
          className="text-xs text-gray-600 hover:text-red-400 transition-colors flex-shrink-0"
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
      return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{inner}</p>
    }
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
