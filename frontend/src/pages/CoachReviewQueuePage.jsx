import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
import { ReviewCardSkeleton } from '../components/Skeleton'

const PAGE_SIZE = 20
const EARN_PER_CREDIT = 0.25 * 0.8 // $0.25/credit, coach keeps 80%

const STATUS_TONES = { pending: 'warning', in_review: 'pads', complete: 'success', cancelled: 'muted' }
const STATUS_LABELS = { pending: 'New', in_review: 'In review', complete: 'Complete', cancelled: 'Cancelled' }

function timeAgo(dateStr) {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'in_review', label: 'In review' },
  { id: 'complete', label: 'Complete' },
]

export default function CoachReviewQueuePage() {
  const api = useApi()
  const navigate = useNavigate()
  const [reviews, setReviews] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('pending')
  const [actionLoading, setActionLoading] = useState(null)
  const [cancelModal, setCancelModal] = useState(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState(false)
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => { load() }, [])

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
      const updated = await api.patch(`/reviews/${cancelModal.id}/cancel`, { cancel_reason: cancelReason || null })
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
    if (review.status === 'pending') await handleStart(review.id)
    navigate(`/reviews/${review.id}/player`)
  }

  const counts = {
    all: reviews.length,
    pending: reviews.filter(r => r.status === 'pending').length,
    in_review: reviews.filter(r => r.status === 'in_review').length,
    complete: reviews.filter(r => r.status === 'complete').length,
  }
  const open = reviews.filter(r => r.status === 'pending' || r.status === 'in_review')
  const creditsWaiting = open.reduce((sum, r) => sum + (r.credits_cost || 0), 0)
  const earningsWaiting = creditsWaiting * EARN_PER_CREDIT

  const filtered = filter === 'all' ? reviews : reviews.filter(r => r.status === filter)

  return (
    <AppLayout active="reviews">
      {/* Cancel modal */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-line bg-surface p-6">
            <h2 className="font-display font-extrabold uppercase tracking-wide text-text">Refund &amp; cancel</h2>
            <p className="text-sm text-text3">
              The athlete will receive a full refund of <span className="font-medium text-text">{cancelModal.credits_cost} credits</span>.
              Let them know why so they can resubmit better footage.
            </p>
            <textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} rows={3} autoFocus
              placeholder="e.g. Camera angle makes the keypoints hard to read, or the footage is too dark..."
              className="input resize-none" />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setCancelModal(null); setCancelReason('') }}>Keep review</Button>
              <Button variant="danger" size="sm" onClick={handleCancelConfirm} disabled={cancelling}>
                {cancelling ? 'Cancelling...' : 'Refund & cancel'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-line bg-surface px-4 py-7 md:px-8">
        <div>
          <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Coach</p>
          <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text md:text-[36px]">Review queue</h1>
          <p className="mt-2 text-sm text-text3">
            {counts.pending} pending · {counts.in_review} in review
          </p>
        </div>
        <div className="rounded-2xl border border-kiwi/20 bg-kiwi/10 px-5 py-3 text-right">
          <p className="font-display text-[28px] font-black leading-none tabular-nums text-kiwi">{creditsWaiting} cr</p>
          <p className="mt-1 text-[11px] font-semibold text-kiwi/60">Pending earnings</p>
          <p className="mt-0.5 text-[11px] text-kiwi/40">= ${earningsWaiting.toFixed(2)} USD</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 border-b border-line bg-surface px-4 py-4 md:px-8">
        {FILTERS.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`chip ${filter === f.id ? 'active' : ''}`}>
            {f.label}
            {counts[f.id] > 0 && (
              <span className={`ml-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 font-display text-[10px] font-black ${
                filter === f.id ? 'bg-kiwi text-black' : 'bg-surface3 text-text3'
              }`}>{counts[f.id]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Cards */}
      <div className="mx-auto max-w-3xl px-4 py-6 md:px-8">
        {loading ? (
          <div className="space-y-3">{[...Array(3)].map((_, i) => <ReviewCardSkeleton key={i} />)}</div>
        ) : filtered.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-sm text-text3">No {filter === 'all' ? '' : STATUS_LABELS[filter]?.toLowerCase() + ' '}reviews{filter === 'all' ? ' yet' : ''}.</p>
            <p className="mt-1 text-xs text-muted">Athlete requests appear here.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {filtered.map(review => (
              <ReviewCard
                key={review.id}
                review={review}
                busy={actionLoading === review.id}
                onStartReview={() => handleStartReview(review)}
                onComplete={() => handleComplete(review.id)}
                onCancel={() => setCancelModal(review)}
                onView={() => navigate(`/reviews/${review.id}/player`)}
              />
            ))}
            {hasMore && filter === 'all' && (
              <div className="mt-3 text-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load more reviews'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </AppLayout>
  )
}

function ReviewCard({ review, busy, onStartReview, onComplete, onCancel, onView }) {
  const title = review.review_type === 'session'
    ? (review.session_label || 'Session review')
    : (review.clip_filename || 'Clip review')
  const earned = (review.credits_cost || 0) * EARN_PER_CREDIT
  const accent = review.status === 'pending' ? 'border-l-kiwi' : review.status === 'in_review' ? 'border-l-warning' : 'border-l-line'

  return (
    <div className={`overflow-hidden rounded-2xl border border-line border-l-2 ${accent} bg-surface`}>
      {/* Top */}
      <div className="flex items-start gap-4 px-5 pb-3 pt-5">
        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl border border-line2 bg-surface2 text-xl">🥊</div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <p className="truncate font-display text-lg font-extrabold text-text">{title}</p>
            <Tag tone={STATUS_TONES[review.status]}>{STATUS_LABELS[review.status]}</Tag>
            <span className="text-[11px] text-muted">{timeAgo(review.created_at)}</span>
          </div>
          {review.athlete_note && (
            <p className="line-clamp-2 text-[13px] italic leading-relaxed text-text3">"{review.athlete_note}"</p>
          )}
        </div>
        <div className="flex-shrink-0 text-right">
          <p className="font-display text-[26px] font-black leading-none tabular-nums text-kiwi">{review.credits_cost} cr</p>
          <p className="mt-1 text-[11px] text-kiwi/50">= ${earned.toFixed(2)} earned</p>
        </div>
      </div>

      {/* Clip strip */}
      <div className="mx-5 flex items-center gap-3 rounded-xl border border-line bg-surface2 px-3.5 py-3">
        <div className="flex h-[46px] w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface3 text-xl">
          {review.clip_thumbnail_url
            ? <img src={review.clip_thumbnail_url} alt="" className="h-full w-full object-cover" />
            : '🎬'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text">{review.clip_filename || review.session_label || 'Clip'}</p>
          <p className="mt-0.5 text-[11px] uppercase tracking-wide text-muted">{review.review_type === 'session' ? 'Session review' : 'Clip review'}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2.5 px-5 pb-5 pt-4">
        {review.status === 'pending' && (
          <>
            <Button size="sm" className="flex-1" onClick={onStartReview} disabled={busy}>Start review →</Button>
            <Button variant="secondary" size="sm" onClick={onView}>View clip</Button>
            <Button variant="danger" size="sm" onClick={onCancel} disabled={busy}>Refund</Button>
          </>
        )}
        {review.status === 'in_review' && (
          <>
            <Button size="sm" className="flex-1" onClick={onStartReview} disabled={busy}>Continue →</Button>
            <Button variant="outline" size="sm" onClick={onComplete} disabled={busy}>Mark complete</Button>
            <Button variant="danger" size="sm" onClick={onCancel} disabled={busy}>Refund</Button>
          </>
        )}
        {review.status === 'complete' && (
          <Button variant="secondary" size="sm" className="flex-1" onClick={onView}>View completed review</Button>
        )}
        {review.status === 'cancelled' && (
          <span className="py-2 text-xs text-muted">Cancelled · credits refunded to the athlete.</span>
        )}
      </div>
    </div>
  )
}
