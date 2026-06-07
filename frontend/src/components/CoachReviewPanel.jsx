import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'

/**
 * Coach-only dashboard right panel (mock: southpaw-dashboard.jsx right-panel).
 * Pending/in-review queue + credit balance + Cash Out via Stripe Connect.
 * Rendered only for coaches and only on xl+ screens by DashboardPage.
 */
function timeAgo(dateStr) {
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function CoachReviewPanel() {
  const api = useApi()
  const navigate = useNavigate()
  const [reviews, setReviews] = useState([])
  const [status, setStatus] = useState(null)   // connect/payout status
  const [loading, setLoading] = useState(true)
  const [payoutLoading, setPayoutLoading] = useState(false)
  const [busy, setBusy] = useState(null)        // review id being started

  useEffect(() => {
    Promise.all([
      api.get('/reviews/me/coach?limit=20&offset=0').catch(() => []),
      api.get('/payments/connect/status').catch(() => null),
    ]).then(([r, s]) => {
      setReviews(Array.isArray(r) ? r : [])
      setStatus(s)
    }).finally(() => setLoading(false))
  }, [])

  const open = reviews.filter(r => r.status === 'pending' || r.status === 'in_review')
  const creditsWaiting = open.reduce((sum, r) => sum + (r.credits_cost || 0), 0)

  async function handleStart(review) {
    setBusy(review.id)
    try {
      if (review.status === 'pending') await api.patch(`/reviews/${review.id}/start`, {})
      navigate(`/reviews/${review.id}/player`)
    } catch (err) {
      console.error('Failed to start review', err)
      setBusy(null)
    }
  }

  async function handlePayout() {
    if (!status) return
    if (!status.stripe_connected || !status.payouts_enabled) {
      try {
        const { onboarding_url } = await api.post('/payments/connect/onboard', {})
        window.location.href = onboarding_url
      } catch (err) { console.error(err) }
      return
    }
    setPayoutLoading(true)
    try {
      await api.post('/payments/connect/payout', {})
      const fresh = await api.get('/payments/connect/status').catch(() => status)
      setStatus(fresh)
    } catch (err) {
      console.error('Payout failed', err)
    } finally {
      setPayoutLoading(false)
    }
  }

  const payoutLabel = !status
    ? 'Cash Out via Stripe'
    : !status.stripe_connected || !status.payouts_enabled
      ? 'Set up payouts'
      : payoutLoading ? 'Processing...' : 'Cash Out via Stripe'

  return (
    <div className="flex h-full flex-col overflow-y-auto border-l border-line bg-surface">
      {/* Header */}
      <div className="border-b border-line px-5 pb-4 pt-7">
        <h2 className="font-display text-base font-extrabold uppercase tracking-wide text-text">Review queue</h2>
        <p className="mt-1 text-xs text-muted">
          {open.length} pending · <span className="text-kiwi">{creditsWaiting} credits</span> waiting
        </p>
      </div>

      {/* Queue */}
      {loading ? (
        <div className="space-y-3 p-5">
          {[...Array(2)].map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-surface2" />)}
        </div>
      ) : open.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-muted">No pending reviews. You're all caught up.</p>
      ) : (
        open.map(r => (
          <div
            key={r.id}
            className={`cursor-pointer border-b border-line px-5 py-4 transition-colors hover:bg-surface2 ${r.status === 'pending' ? 'border-l-2 border-l-kiwi' : ''}`}
            onClick={() => handleStart(r)}
          >
            <div className="flex items-center gap-3">
              <div className="flex h-7 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface3 text-xs">
                {r.clip_thumbnail_url
                  ? <img src={r.clip_thumbnail_url} alt="" className="h-full w-full object-cover" />
                  : '🎬'}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-text">
                  {r.review_type === 'session' ? (r.session_label || 'Session') : (r.clip_filename || 'Clip')}
                </p>
                <p className="text-[11px] text-muted">{timeAgo(r.created_at)}</p>
              </div>
              <span className="flex-shrink-0 font-display text-sm font-bold text-kiwi tabular-nums">{r.credits_cost}cr</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); handleStart(r) }}
              disabled={busy === r.id}
              className="btn btn-primary mt-2.5 w-full py-2 text-[13px] disabled:opacity-50"
            >
              {busy === r.id ? '...' : r.status === 'in_review' ? 'Continue →' : 'Start review →'}
            </button>
          </div>
        ))
      )}

      {/* Balance + cash out */}
      <div className="mt-auto border-t border-line p-5">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-muted">Your balance</p>
        <div className="mb-2 flex justify-between">
          <span className="text-[13px] text-text3">Credits earned</span>
          <span className="font-display text-base font-bold text-kiwi tabular-nums">{status?.credits_balance ?? '—'} cr</span>
        </div>
        <div className="mb-4 flex justify-between">
          <span className="text-[13px] text-text3">Ready to cash out</span>
          <span className="font-display text-base font-bold text-text tabular-nums">
            {status ? `$${status.payout_value_dollars.toFixed(2)}` : '—'}
          </span>
        </div>
        <button
          onClick={handlePayout}
          disabled={payoutLoading || (status && status.stripe_connected && status.payouts_enabled && !status.can_payout)}
          title={status && status.payouts_enabled && !status.can_payout ? `Minimum ${status.minimum_payout_credits} credits to cash out` : ''}
          className="btn btn-outline w-full py-2.5 text-[13px] disabled:opacity-50"
        >
          {payoutLabel}
        </button>
        {status && status.payouts_enabled && !status.can_payout && (
          <p className="mt-2 text-[11px] text-muted">Minimum {status.minimum_payout_credits} credits to cash out.</p>
        )}
      </div>
    </div>
  )
}
