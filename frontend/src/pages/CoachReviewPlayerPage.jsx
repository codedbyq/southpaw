import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import CanvasPlayer from '../components/CanvasPlayer'
import { PlayerSkeleton } from '../components/Skeleton'

export default function CoachReviewPlayerPage() {
  const { reviewId } = useParams()
  const navigate = useNavigate()
  const api = useApi()

  const [clipData, setClipData] = useState(null)
  const [review, setReview] = useState(null)
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [commentBody, setCommentBody] = useState('')
  const [commentTimestamp, setCommentTimestamp] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [completing, setCompleting] = useState(false)
  const commentInputRef = useRef(null)

  useEffect(() => {
    async function load() {
      try {
        const [accessData, reviewsData] = await Promise.all([
          api.get(`/reviews/${reviewId}/clip-access`),
          api.get('/reviews/me/coach'),
        ])
        setClipData(accessData)
        const thisReview = reviewsData.find(r => r.id === reviewId)
        setReview(thisReview)

        // Session reviews — redirect to session page
        if (accessData.review_type === 'session' && accessData.session_id) {
          navigate(`/sessions/${accessData.session_id}`, { replace: true })
          return
        }

        if (accessData.clip_id) {
          const commentsData = await api.get(`/clips/${accessData.clip_id}/comments`)
          setComments(commentsData)
        }
      } catch (err) {
        setError('Failed to load review')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [reviewId])

  function handleTimeClick(t) {
    setCommentTimestamp(t)
    commentInputRef.current?.focus()
  }

  async function handleSubmitComment(e) {
    e.preventDefault()
    if (!commentBody.trim() || !clipData) return
    setSubmitting(true)
    try {
      const newComment = await api.post(`/clips/${clipData.clip_id}/comments`, {
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

  async function handleComplete() {
    setCompleting(true)
    try {
      await api.patch(`/reviews/${reviewId}/complete`, {})
      navigate('/reviews/queue')
    } catch (err) {
      console.error('Failed to complete review', err)
      setCompleting(false)
    }
  }

  if (loading) return (
    <div className="min-h-screen bg-gray-950">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <div className="w-28 h-4 bg-gray-800 animate-pulse rounded" />
        <div className="flex-1 h-4 bg-gray-800 animate-pulse rounded max-w-xs" />
      </nav>
      <main className="max-w-5xl mx-auto px-6 py-8"><PlayerSkeleton /></main>
    </div>
  )

  if (error || !clipData) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-red-400 text-sm">{error || 'Review not found'}</p>
    </div>
  )

  const isComplete = clipData.review_status === 'complete'
  const timestampedComments = comments.filter(c => c.timestamp_seconds != null)
  const generalComments = comments.filter(c => c.timestamp_seconds == null)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <button onClick={() => navigate('/reviews/queue')} className="text-gray-400 hover:text-white text-sm transition-colors">
          ← Review queue
        </button>
        <span className="font-medium text-sm text-gray-300 truncate flex-1">{clipData.filename}</span>
        {!isComplete && (
          <button
            onClick={handleComplete}
            disabled={completing}
            className="px-4 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {completing ? 'Completing...' : '✓ Mark complete'}
          </button>
        )}
        {isComplete && (
          <span className="text-xs px-3 py-1.5 bg-green-900 text-green-400 rounded-lg font-medium">
            Review complete
          </span>
        )}
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {review?.athlete_note && (
          <div className="p-4 bg-gray-900 border border-gray-700 rounded-xl">
            <p className="text-xs text-gray-500 mb-1">Athlete's note</p>
            <p className="text-sm text-gray-300">"{review.athlete_note}"</p>
          </div>
        )}

        <CanvasPlayer
          videoUrl={clipData.video_url}
          resultUrl={clipData.result_url}
          comments={comments}
          onTimeClick={handleTimeClick}
        />

        {/* Comment input */}
        {!isComplete && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-3">Leave timestamped feedback — click the timeline to pin a comment to a moment</p>
            <form onSubmit={handleSubmitComment} className="flex flex-col gap-3">
              {commentTimestamp != null && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-yellow-400">📍 {commentTimestamp.toFixed(1)}s</span>
                  <button type="button" onClick={() => setCommentTimestamp(null)} className="text-xs text-gray-500 hover:text-white">
                    × remove
                  </button>
                </div>
              )}
              <div className="flex gap-2">
                <input
                  ref={commentInputRef}
                  type="text"
                  value={commentBody}
                  onChange={e => setCommentBody(e.target.value)}
                  placeholder={commentTimestamp != null ? `Feedback at ${commentTimestamp.toFixed(1)}s...` : 'General feedback...'}
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
        )}

        {/* Comments */}
        {timestampedComments.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3">Timeline feedback</h3>
            <div className="flex flex-col gap-2">
              {timestampedComments.map(c => (
                <div key={c.id} className="flex items-start gap-3 p-3 bg-gray-900 border border-gray-800 rounded-lg">
                  <span className="text-xs text-yellow-400 font-mono mt-0.5 flex-shrink-0">{c.timestamp_seconds.toFixed(1)}s</span>
                  <div className="flex-1">
                    <span className="text-xs text-gray-500 mr-2">{c.author_name}</span>
                    <span className="text-sm text-gray-300">{c.body}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {generalComments.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3">General feedback</h3>
            <div className="flex flex-col gap-2">
              {generalComments.map(c => (
                <div key={c.id} className="p-3 bg-gray-900 border border-gray-800 rounded-lg">
                  <span className="text-xs text-gray-500 mr-2">{c.author_name}</span>
                  <span className="text-sm text-gray-300">{c.body}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
