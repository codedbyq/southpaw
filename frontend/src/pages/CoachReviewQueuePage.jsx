import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import { ReviewCardSkeleton } from '../components/Skeleton'

const STATUS_STYLES = {
  pending:   'bg-yellow-900 text-yellow-400',
  in_review: 'bg-blue-900 text-blue-400',
  complete:  'bg-green-900 text-green-400',
  cancelled: 'bg-gray-800 text-gray-500',
}

const STATUS_LABELS = {
  pending:   'Pending',
  in_review: 'In review',
  complete:  'Complete',
  cancelled: 'Cancelled',
}

export default function CoachReviewQueuePage() {
  const api = useApi()
  const navigate = useNavigate()
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(null)
  const [cancelModal, setCancelModal] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const PAGE_SIZE = 20

  useEffect(() => {
    load()
  }, [])

  async function load() {
    try {
      const data = await api.get(`/reviews/me/coach?limit=${PAGE_SIZE}&offset=0`)
      setReviews(data)
      setOffset(PAGE_SIZE)
      setHasMore(data.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load review queue', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    setLoadingMore(true)
    try {
      const more = await api.get(`/reviews/me/coach?limit=${PAGE_SIZE}&offset=${offset}`)
      setReviews(prev => [...prev, ...more])
      setOffset(prev => prev + PAGE_SIZE)
      setHasMore(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load more reviews', err)
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleStart(reviewId) {
    setActionLoading(reviewId)
    try {
      const updated = await api.patch(`/reviews/${reviewId}/start`, {})
      setReviews(prev => prev.map(r => r.id === reviewId ? updated : r))
    } catch (err) {
      console.error('Failed to start review', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleComplete(reviewId) {
    setActionLoading(reviewId)
    try {
      const updated = await api.patch(`/reviews/${reviewId}/complete`, {})
      setReviews(prev => prev.map(r => r.id === reviewId ? updated : r))
    } catch (err) {
      console.error('Failed to complete review', err)
    } finally {
      setActionLoading(null)
    }
  }

  async function handleCancelConfirm() {
    if (!cancelModal) return
    setCancelling(true)
    try {
      const updated = await api.patch(`/reviews/${cancelModal.id}/cancel`, {
        cancel_reason: cancelReason || null,
      })
      setReviews(prev => prev.map(r => r.id === cancelModal.id ? updated : r))
      setCancelModal(null)
      setCancelReason('')
    } catch (err) {
      console.error('Failed to cancel review', err)
    } finally {
      setCancelling(false)
    }
  }

  async function handleStartReview(review) {
    // Start the review if still pending, then navigate to clip
    if (review.status === 'pending') {
      await handleStart(review.id)
    }
    navigate(`/reviews/${review.id}/player`)
  }

  const pending = reviews.filter(r => r.status === 'pending')
  const inReview = reviews.filter(r => r.status === 'in_review')
  const completed = reviews.filter(r => r.status === 'complete')

  return (
    <div className="min-h-screen bg-gray-950 text-white">

      {/* Cancel modal */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-semibold text-white">Cancel review</h2>
            <p className="text-sm text-gray-400">
              The athlete will receive a full refund of <span className="text-white font-medium">{cancelModal.credits_cost} credits</span>.
              Let them know why so they can resubmit better footage.
            </p>
            <div>
              <label className="text-xs text-gray-500 mb-1 block">Reason (optional but helpful)</label>
              <textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="e.g. Camera angle makes it impossible to see keypoints clearly, or footage is too dark..."
                rows={3}
                autoFocus
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-red-500 resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => { setCancelModal(null); setCancelReason('') }}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors"
              >
                Keep review
              </button>
              <button
                onClick={handleCancelConfirm}
                disabled={cancelling}
                className="px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
              >
                {cancelling ? 'Cancelling...' : 'Cancel & refund'}
              </button>
            </div>
          </div>
        </div>
      )}

      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-400 hover:text-white transition-colors">
          ← Dashboard
        </button>
        <span className="font-bold text-lg tracking-tight">Review queue</span>
        <UserButton />
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-10 space-y-10">
        {loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <ReviewCardSkeleton key={i} />)}
          </div>
        ) : reviews.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 text-sm">No review requests yet.</p>
            <p className="text-gray-600 text-xs mt-1">When athletes request your review it will appear here.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {/* Pending + In Review */}
            {[...pending, ...inReview].length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">
                  Action needed ({[...pending, ...inReview].length})
                </h2>
                <div className="flex flex-col gap-3">
                  {[...inReview, ...pending].map(review => (
                    <ReviewCard
                      key={review.id}
                      review={review}
                      onStartReview={() => handleStartReview(review)}
                      onComplete={() => handleComplete(review.id)}
                      onCancel={() => setCancelModal(review)}
                      actionLoading={actionLoading === review.id}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Completed */}
            {completed.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-4">
                  Completed ({completed.length})
                </h2>
                <div className="flex flex-col gap-3">
                  {completed.map(review => (
                    <ReviewCard
                      key={review.id}
                      review={review}
                      onStartReview={() => navigate(`/reviews/${review.id}/player`)}
                      actionLoading={false}
                    />
                  ))}
                </div>
              </div>
            )}

            {hasMore && (
              <div className="text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Loading...' : 'Load more reviews'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}


function ReviewCard({ review, onStartReview, onComplete, onCancel, actionLoading }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start gap-4">
      {/* Thumbnail */}
      <div className="w-16 h-12 rounded-lg bg-gray-800 flex-shrink-0 overflow-hidden">
        {review.clip_thumbnail_url
          ? <img src={review.clip_thumbnail_url} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">🎬</div>
        }
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm text-white font-medium truncate">
            {review.review_type === 'session'
              ? `Session: ${review.session_label || 'Untitled session'}`
              : review.clip_filename || 'Clip'}
          </p>
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${STATUS_STYLES[review.status]}`}>
            {STATUS_LABELS[review.status]}
          </span>
        </div>

        {review.athlete_note && (
          <p className="text-xs text-gray-400 mb-1">"{review.athlete_note}"</p>
        )}

        <p className="text-xs text-gray-600">
          {new Date(review.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' · '}{review.credits_cost} credits
        </p>
      </div>

      <div className="flex flex-col gap-2 flex-shrink-0">
        {review.status !== 'complete' && (
          <button
            onClick={onStartReview}
            disabled={actionLoading}
            className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            {review.status === 'in_review' ? 'Continue' : 'Start review'}
          </button>
        )}
        {review.status === 'in_review' && onComplete && (
          <button
            onClick={onComplete}
            disabled={actionLoading}
            className="text-xs px-3 py-1.5 bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white rounded-lg transition-colors"
          >
            Mark complete
          </button>
        )}
        {review.status === 'complete' && (
          <button
            onClick={onStartReview}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded-lg transition-colors"
          >
            View clip
          </button>
        )}
        {['pending', 'in_review'].includes(review.status) && onCancel && (
          <button
            onClick={onCancel}
            disabled={actionLoading}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-red-900 text-gray-500 hover:text-red-400 disabled:opacity-50 rounded-lg transition-colors"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
