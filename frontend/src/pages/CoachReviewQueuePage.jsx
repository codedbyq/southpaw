import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
import { ReviewCardSkeleton } from '../components/Skeleton'

const STATUS_TONES = {
  pending:   'warning',
  in_review: 'pads',
  complete:  'success',
  cancelled: 'muted',
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

  // Credits waiting to be earned across open reviews
  const creditsWaiting = [...pending, ...inReview].reduce((sum, r) => sum + (r.credits_cost || 0), 0)

  return (
    <AppLayout active="reviews">
      {/* Cancel modal */}
      {cancelModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
          <div className="bg-surface border border-line rounded-2xl w-full max-w-md p-6 space-y-4">
            <h2 className="font-display font-extrabold uppercase tracking-wide text-text">Cancel review</h2>
            <p className="text-sm text-text3">
              The athlete will receive a full refund of <span className="text-text font-medium">{cancelModal.credits_cost} credits</span>.
              Let them know why so they can resubmit better footage.
            </p>
            <div>
              <label className="text-xs text-muted mb-1 block">Reason (optional but helpful)</label>
              <textarea
                value={cancelReason}
                onChange={e => setCancelReason(e.target.value)}
                placeholder="e.g. Camera angle makes it impossible to see keypoints clearly, or footage is too dark..."
                rows={3}
                autoFocus
                className="input resize-none"
              />
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="secondary" size="sm" onClick={() => { setCancelModal(null); setCancelReason('') }}>
                Keep review
              </Button>
              <Button variant="danger" size="sm" onClick={handleCancelConfirm} disabled={cancelling}>
                {cancelling ? 'Cancelling...' : 'Cancel & refund'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-3xl mx-auto px-8 py-10 space-y-10">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Coach</p>
            <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text">Review queue</h1>
          </div>
          {creditsWaiting > 0 && (
            <div className="flex items-center gap-1.5 rounded-full border border-kiwi/40 bg-kiwi/8 px-4 py-2">
              <span className="text-kiwi">⚡</span>
              <span className="font-display font-bold tabular-nums text-kiwi">{creditsWaiting}</span>
              <span className="text-xs text-text3">credits waiting</span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => <ReviewCardSkeleton key={i} />)}
          </div>
        ) : reviews.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-text3 text-sm">No review requests yet.</p>
            <p className="text-muted text-xs mt-1">When athletes request your review it will appear here.</p>
          </div>
        ) : (
          <div className="space-y-10">
            {/* Pending + In Review */}
            {[...pending, ...inReview].length > 0 && (
              <div>
                <h2 className="text-sm font-display font-bold text-muted uppercase tracking-wide mb-4">
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
                <h2 className="text-sm font-display font-bold text-muted uppercase tracking-wide mb-4">
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
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load more reviews'}
                </Button>
              </div>
            )}
          </div>
        )}
      </main>
    </AppLayout>
  )
}


function ReviewCard({ review, onStartReview, onComplete, onCancel, actionLoading }) {
  const accent = review.status === 'complete' ? 'border-l-kiwi'
    : review.status === 'in_review' ? 'border-l-sport-pads'
    : 'border-l-warning'
  return (
    <div className={`bg-surface border border-line border-l-2 ${accent} rounded-2xl p-4 flex items-start gap-4`}>
      {/* Thumbnail */}
      <div className="w-16 h-12 rounded-lg bg-surface3 flex-shrink-0 overflow-hidden">
        {review.clip_thumbnail_url
          ? <img src={review.clip_thumbnail_url} alt="" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-muted text-xs">🎬</div>
        }
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm text-text font-medium truncate">
            {review.review_type === 'session'
              ? `Session: ${review.session_label || 'Untitled session'}`
              : review.clip_filename || 'Clip'}
          </p>
          <Tag tone={STATUS_TONES[review.status]}>{STATUS_LABELS[review.status]}</Tag>
        </div>

        {review.athlete_note && (
          <p className="text-xs text-text3 mb-1">"{review.athlete_note}"</p>
        )}

        <p className="text-xs text-muted">
          {new Date(review.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
          {' · '}<span className="font-display font-bold text-kiwi tabular-nums">{review.credits_cost} cr</span>
        </p>
      </div>

      <div className="flex flex-col gap-2 flex-shrink-0">
        {review.status !== 'complete' && (
          <Button size="sm" onClick={onStartReview} disabled={actionLoading}>
            {review.status === 'in_review' ? 'Continue' : 'Start review'}
          </Button>
        )}
        {review.status === 'in_review' && onComplete && (
          <Button variant="outline" size="sm" onClick={onComplete} disabled={actionLoading}>
            Mark complete
          </Button>
        )}
        {review.status === 'complete' && (
          <Button variant="secondary" size="sm" onClick={onStartReview}>
            View clip
          </Button>
        )}
        {['pending', 'in_review'].includes(review.status) && onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={actionLoading}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}
