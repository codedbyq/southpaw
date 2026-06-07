import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import UploadButton from '../components/UploadButton'
import ClipCard from '../components/ClipCard'
import SessionCard from '../components/SessionCard'
import StatsBar from '../components/StatsBar'
import { StatsBarSkeleton, SessionCardSkeleton, ClipCardSkeleton } from '../components/Skeleton'
import StarRating from '../components/StarRating'
import Tag from '../components/Tag'

const SPORTS = [
  { value: 'boxing',    label: 'Boxing' },
  { value: 'muay_thai', label: 'Muay Thai' },
  { value: 'mma',       label: 'MMA' },
]

const SESSION_TYPES = [
  { value: 'sparring', label: 'Sparring' },
  { value: 'bag',      label: 'Bag work' },
  { value: 'pads',     label: 'Pads' },
  { value: 'shadow',   label: 'Shadow boxing' },
]

export default function DashboardPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [currentUser, setCurrentUser] = useState(null)
  const [hasCoachProfile, setHasCoachProfile] = useState(null)
  const [athleteReviews, setAthleteReviews] = useState([])
  const [ratingLoading, setRatingLoading] = useState(null)

  // Pagination
  const PAGE_SIZE = 20
  const [sessionOffset, setSessionOffset] = useState(0)
  const [clipOffset, setClipOffset] = useState(0)
  const [hasMoreSessions, setHasMoreSessions] = useState(false)
  const [hasMoreClips, setHasMoreClips] = useState(false)
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false)
  const [loadingMoreClips, setLoadingMoreClips] = useState(false)

  // Bulk selection for unorganized clips
  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  const [bulkSessionId, setBulkSessionId] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)
  const [paymentBanner, setPaymentBanner] = useState(null) // 'success' | 'cancelled'

  // Trend feedback
  const [trendFeedback, setTrendFeedback] = useState(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendError, setTrendError] = useState(null)

  // New session inline form
  const [showNewSession, setShowNewSession] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newSport, setNewSport] = useState('boxing')
  const [newType, setNewType] = useState('sparring')
  const [newNotes, setNewNotes] = useState('')
  const [creating, setCreating] = useState(false)

  async function loadData() {
    try {
      const [sessionsData, clipsData, userData, statsData] = await Promise.all([
        api.get(`/sessions?limit=${PAGE_SIZE}&offset=0`),
        api.get(`/clips?limit=${PAGE_SIZE}&offset=0`),
        api.get('/users/me'),
        api.get('/users/me/stats'),
      ])
      setSessions(sessionsData)
      setClips(clipsData)
      setSessionOffset(PAGE_SIZE)
      setClipOffset(PAGE_SIZE)
      setHasMoreSessions(sessionsData.length === PAGE_SIZE)
      setHasMoreClips(clipsData.length === PAGE_SIZE)
      setStats(statsData)
      setCurrentUser(userData)

      // Load athlete reviews
      try {
        const reviewsData = await api.get('/reviews/me/athlete')
        setAthleteReviews(reviewsData)
      } catch {}

      // Check if coach has a profile set up
      if (userData.user_type === 'coach') {
        try {
          await api.get('/coaches/me/profile')
          setHasCoachProfile(true)
        } catch {
          setHasCoachProfile(false)
        }
      }

      if (userData.trend_feedback) {
        setTrendFeedback({
          feedback: userData.trend_feedback,
          session_count: sessionsData.filter(s => s.clip_count > 0).length,
        })
      }
    } catch (err) {
      console.error('Failed to load dashboard', err)
    } finally {
      setLoading(false)
    }
  }

  async function handleRateReview(reviewId, rating) {
    setRatingLoading(reviewId)
    try {
      const updated = await api.patch(`/reviews/${reviewId}/rate`, { rating })
      setAthleteReviews(prev => prev.map(r => r.id === reviewId ? updated : r))
    } catch (err) {
      console.error('Failed to rate review', err)
    } finally {
      setRatingLoading(null)
    }
  }

  async function loadMoreSessions() {
    setLoadingMoreSessions(true)
    try {
      const more = await api.get(`/sessions?limit=${PAGE_SIZE}&offset=${sessionOffset}`)
      setSessions(prev => [...prev, ...more])
      setSessionOffset(prev => prev + PAGE_SIZE)
      setHasMoreSessions(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load more sessions', err)
    } finally {
      setLoadingMoreSessions(false)
    }
  }

  async function loadMoreClips() {
    setLoadingMoreClips(true)
    try {
      const more = await api.get(`/clips?limit=${PAGE_SIZE}&offset=${clipOffset}`)
      setClips(prev => [...prev, ...more])
      setClipOffset(prev => prev + PAGE_SIZE)
      setHasMoreClips(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load more clips', err)
    } finally {
      setLoadingMoreClips(false)
    }
  }

  function toggleClipSelect(clipId) {
    setSelectedClipIds(prev => {
      const next = new Set(prev)
      next.has(clipId) ? next.delete(clipId) : next.add(clipId)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedClipIds.size === unorganizedClips.length) {
      setSelectedClipIds(new Set())
    } else {
      setSelectedClipIds(new Set(unorganizedClips.map(c => c.id)))
    }
  }

  async function handleBulkAssign() {
    if (!bulkSessionId || !selectedClipIds.size) return
    setBulkLoading(true)
    try {
      await Promise.all(
        [...selectedClipIds].map(id => api.patch(`/clips/${id}`, { session_id: bulkSessionId }))
      )
      setSelectedClipIds(new Set())
      setBulkSessionId('')
      await loadData()
    } catch (err) {
      console.error('Bulk assign failed', err)
    } finally {
      setBulkLoading(false)
    }
  }

  async function handleBulkDelete() {
    if (!selectedClipIds.size) return
    if (!confirm(`Delete ${selectedClipIds.size} clip${selectedClipIds.size !== 1 ? 's' : ''}? This cannot be undone.`)) return
    setBulkLoading(true)
    try {
      await Promise.all([...selectedClipIds].map(id => api.delete(`/clips/${id}`)))
      setSelectedClipIds(new Set())
      await loadData()
    } catch (err) {
      console.error('Bulk delete failed', err)
    } finally {
      setBulkLoading(false)
    }
  }

  async function handleTrendFeedback() {
    setTrendLoading(true)
    setTrendError(null)
    try {
      const data = await api.get('/sessions/trend-feedback')
      setTrendFeedback(data)
    } catch (err) {
      setTrendError(err.message)
    } finally {
      setTrendLoading(false)
    }
  }

  async function handleCreateSession(e) {
    e.preventDefault()
    setCreating(true)
    try {
      await api.post('/sessions', {
        label: newLabel || null,
        sport: newSport,
        session_type: newType,
        notes: newNotes || null,
      })
      setShowNewSession(false)
      setNewLabel('')
      setNewSport('boxing')
      setNewType('sparring')
      setNewNotes('')
      await loadData()
    } catch (err) {
      console.error('Failed to create session', err)
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    // Check for Stripe redirect params
    const params = new URLSearchParams(window.location.search)
    const payment = params.get('payment')
    const subscription = params.get('subscription')
    if (payment === 'success' || subscription === 'success') {
      setPaymentBanner('success')
      window.history.replaceState({}, '', '/dashboard')
    } else if (payment === 'cancelled') {
      setPaymentBanner('cancelled')
      window.history.replaceState({}, '', '/dashboard')
    }
    loadData()
  }, [])

  // Clips not yet assigned to a session
  const [search, setSearch] = useState('')
  const searchLower = search.toLowerCase()

  const unorganizedClips = clips.filter(c => !c.session_id)

  const filteredSessions = searchLower
    ? sessions.filter(s =>
        (s.label || '').toLowerCase().includes(searchLower) ||
        (s.sport || '').toLowerCase().includes(searchLower) ||
        (s.session_type || '').toLowerCase().includes(searchLower)
      )
    : sessions

  const filteredClips = searchLower
    ? unorganizedClips.filter(c => c.filename.toLowerCase().includes(searchLower))
    : unorganizedClips

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <AppLayout active="dashboard">
      <div className="mx-auto max-w-5xl px-8 py-8">
        {/* ── Greeting header ── */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">{today}</p>
            <h1 className="mt-1 font-display text-[32px] font-extrabold leading-tight text-text">
              {currentUser?.user_type === 'coach' ? 'Coach dashboard' : 'Welcome back'}
            </h1>
          </div>
          <UploadButton onUploadComplete={loadData} />
        </div>

        {paymentBanner && (
          <div className={`mb-6 flex items-center justify-between rounded-2xl p-4 ${
            paymentBanner === 'success'
              ? 'border border-kiwi/40 bg-kiwi/8'
              : 'border border-line bg-surface'
          }`}>
            <p className={`text-sm font-medium ${paymentBanner === 'success' ? 'text-kiwi' : 'text-text3'}`}>
              {paymentBanner === 'success'
                ? '✓ Payment successful — your credits have been added'
                : 'Payment cancelled — no charge was made'}
            </p>
            <button onClick={() => setPaymentBanner(null)} className="ml-4 text-muted hover:text-text">×</button>
          </div>
        )}

        {loading ? (
          <div className="space-y-6">
            <StatsBarSkeleton />
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => <SessionCardSkeleton key={i} />)}
            </div>
            <div className="space-y-3 mt-8">
              {[...Array(2)].map((_, i) => <ClipCardSkeleton key={i} />)}
            </div>
          </div>
        ) : (
          <>
            <StatsBar stats={stats} />

            {/* ── Free tier upgrade prompt ── */}
            {currentUser?.subscription_tier === 'free' && (
              <div className="mb-6 flex items-center justify-between rounded-2xl border border-line bg-surface p-4">
                <div>
                  <p className="text-sm font-medium text-text">You're on the Free plan</p>
                  <p className="mt-0.5 text-xs text-muted">
                    3 clips/month · Upgrade for unlimited clips, session feedback and more credits
                  </p>
                </div>
                <Button size="sm" onClick={() => navigate('/pricing')} className="ml-6 flex-shrink-0">Upgrade</Button>
              </div>
            )}

            {/* ── Coach profile prompt ── */}
            {currentUser?.user_type === 'coach' && hasCoachProfile === false && (
              <div className="mb-8 flex items-center justify-between rounded-2xl border border-kiwi/40 bg-kiwi/8 p-5">
                <div>
                  <p className="text-sm font-medium text-text">Set up your coach profile</p>
                  <p className="mt-0.5 text-xs text-text3">
                    Add your bio, specializations, and credit rate to appear in the marketplace.
                  </p>
                </div>
                <Button size="sm" onClick={() => navigate('/coach/profile')} className="ml-6 flex-shrink-0">Set up profile</Button>
              </div>
            )}

            {/* ── Coach profile link (profile exists) ── */}
            {currentUser?.user_type === 'coach' && hasCoachProfile === true && (
              <div className="mb-8 flex justify-end">
                <button
                  onClick={() => navigate('/coach/profile')}
                  className="text-sm text-muted transition-colors hover:text-kiwi"
                >
                  Edit coach profile →
                </button>
              </div>
            )}

            {/* ── Trend Feedback ── */}
            {sessions.length >= 1 && (
              <div className="relative mb-10 overflow-hidden rounded-2xl border border-line bg-surface p-5">
                <span className="absolute inset-y-0 left-0 w-[3px] bg-kiwi" />
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-text">Progress analysis</h2>
                    <p className="mt-0.5 text-xs text-muted">AI coaching trends across your last sessions</p>
                  </div>
                  {sessions.length >= 2 && (
                    <Button size="sm" onClick={handleTrendFeedback} disabled={trendLoading}>
                      {trendLoading ? 'Analysing...' : trendFeedback ? 'Refresh' : 'Analyse progress'}
                    </Button>
                  )}
                </div>

                {sessions.length < 2 ? (
                  <p className="text-sm text-muted">
                    1 more session needed to unlock progress analysis.
                  </p>
                ) : trendError ? (
                  <p className="text-sm text-danger">{trendError}</p>
                ) : trendFeedback && !trendLoading ? (
                  <div>
                    <p className="mb-3 text-xs text-muted">
                      Based on {trendFeedback.session_count} sessions
                    </p>
                    <div className="whitespace-pre-wrap text-sm leading-relaxed text-text2">
                      {trendFeedback.feedback}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted">
                    Click analyse to see how your training has progressed over time.
                  </p>
                )}
              </div>
            )}

            {/* ── Pending reviews ── */}
            {athleteReviews.filter(r => r.status !== 'cancelled').length > 0 && (
              <div className="mb-10">
                <h2 className="mb-4 font-display text-xl font-extrabold uppercase tracking-wide text-text">Coach reviews</h2>
                <div className="flex flex-col gap-3">
                  {athleteReviews.filter(r => r.status !== 'cancelled').map(review => (
                    <div key={review.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
                      <div
                        onClick={() => review.clip_id && navigate(`/clips/${review.clip_id}`)}
                        className={`flex items-center gap-4 p-4 transition-colors ${review.clip_id ? 'cursor-pointer hover:bg-surface2' : ''}`}
                      >
                        <div className="h-10 w-14 flex-shrink-0 overflow-hidden rounded-lg bg-surface3">
                          {review.clip_thumbnail_url
                            ? <img src={review.clip_thumbnail_url} alt="" className="h-full w-full object-cover" />
                            : <div className="flex h-full w-full items-center justify-center text-xs text-muted">🎬</div>
                          }
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-text">{review.clip_filename || 'Clip'}</p>
                          <p className="mt-0.5 text-xs text-muted">
                            {review.coach_display_name || 'Coach'} · {review.credits_cost} credits
                          </p>
                        </div>
                        <Tag tone={
                          review.status === 'complete' ? 'success' :
                          review.status === 'in_review' ? 'pads' : 'warning'
                        }>
                          {review.status === 'complete' ? 'Complete' :
                           review.status === 'in_review' ? 'In review' : 'Pending'}
                        </Tag>
                      </div>

                      {/* Rating row — only for complete reviews */}
                      {review.status === 'complete' && (
                        <div className="flex items-center gap-3 border-t border-line px-4 pb-3 pt-3">
                          {review.athlete_rating ? (
                            <>
                              <span className="text-xs text-muted">Your rating:</span>
                              <StarRating value={review.athlete_rating} readonly size="sm" />
                            </>
                          ) : (
                            <>
                              <span className="text-xs text-muted">Rate this review:</span>
                              <StarRating
                                value={null}
                                size="sm"
                                onChange={rating => handleRateReview(review.id, rating)}
                              />
                              {ratingLoading === review.id && (
                                <span className="text-xs text-muted">Saving...</span>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Search ── */}
            {(sessions.length > 3 || unorganizedClips.length > 3) && (
              <div className="relative mb-6">
                <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search sessions and clips..."
                  className="input pl-9"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text"
                  >
                    ×
                  </button>
                )}
              </div>
            )}

            {/* ── Sessions ── */}
            <div className="mb-5 flex items-center justify-between">
              <h2 className="font-display text-xl font-extrabold uppercase tracking-wide text-text">Your sessions</h2>
              <Button variant="secondary" size="sm" onClick={() => setShowNewSession(v => !v)}>
                {showNewSession ? 'Cancel' : '+ New session'}
              </Button>
            </div>

            {showNewSession && (
              <form
                onSubmit={handleCreateSession}
                className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border border-line2 bg-surface p-4"
              >
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted">Label (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Saturday sparring"
                    value={newLabel}
                    onChange={e => setNewLabel(e.target.value)}
                    className="input w-48"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted">Sport</label>
                  <select
                    value={newSport}
                    onChange={e => setNewSport(e.target.value)}
                    className="input"
                  >
                    {SPORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-muted">Type</label>
                  <select
                    value={newType}
                    onChange={e => setNewType(e.target.value)}
                    className="input"
                  >
                    {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="flex w-full flex-col gap-1">
                  <label className="text-xs text-muted">Notes (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Working on footwork and combinations"
                    value={newNotes}
                    onChange={e => setNewNotes(e.target.value)}
                    className="input"
                  />
                </div>
                <Button type="submit" size="sm" disabled={creating}>
                  {creating ? 'Creating...' : 'Create'}
                </Button>
              </form>
            )}

            {sessions.length === 0 ? (
              <p className="mb-12 text-sm text-muted">
                No sessions yet. Create one above or tag a clip to a session during upload.
              </p>
            ) : filteredSessions.length === 0 ? (
              <p className="mb-12 text-sm text-muted">No sessions match "{search}".</p>
            ) : (
              <>
                <div className="mb-4 flex flex-col gap-3">
                  {filteredSessions.map(session => (
                    <SessionCard key={session.id} session={session} />
                  ))}
                </div>
                {hasMoreSessions && !searchLower && (
                  <div className="mb-8 text-center">
                    <Button variant="secondary" size="sm" onClick={loadMoreSessions} disabled={loadingMoreSessions}>
                      {loadingMoreSessions ? 'Loading...' : 'Load more sessions'}
                    </Button>
                  </div>
                )}
              </>
            )}

            {/* ── Unorganized clips ── */}
            <div className="mb-3 mt-10 flex items-center justify-between">
              <h2 className="font-display text-xl font-extrabold uppercase tracking-wide text-text">
                Unorganized clips
                {unorganizedClips.length > 0 && (
                  <span className="ml-2 font-sans text-sm font-normal text-muted">
                    {unorganizedClips.length}
                  </span>
                )}
              </h2>
              <UploadButton onUploadComplete={loadData} />
            </div>

            {/* Select all row */}
            {unorganizedClips.length > 1 && (
              <div className="mb-3 flex items-center gap-3">
                <button
                  onClick={toggleSelectAll}
                  className="text-xs text-muted transition-colors hover:text-text"
                >
                  {selectedClipIds.size === unorganizedClips.length ? 'Deselect all' : 'Select all'}
                </button>
                {selectedClipIds.size > 0 && (
                  <span className="text-xs text-muted">
                    {selectedClipIds.size} selected
                  </span>
                )}
              </div>
            )}

            {/* Bulk action bar */}
            {selectedClipIds.size > 0 && (
              <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line2 bg-surface p-3">
                <select
                  value={bulkSessionId}
                  onChange={e => setBulkSessionId(e.target.value)}
                  className="input flex-1"
                >
                  <option value="">Assign to session...</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.label || `${s.session_type || 'Session'}`}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={handleBulkAssign} disabled={!bulkSessionId || bulkLoading}>
                  {bulkLoading ? 'Moving...' : 'Assign'}
                </Button>
                <Button variant="danger" size="sm" onClick={handleBulkDelete} disabled={bulkLoading}>
                  Delete {selectedClipIds.size}
                </Button>
                <button
                  onClick={() => setSelectedClipIds(new Set())}
                  className="text-xs text-muted transition-colors hover:text-text"
                >
                  Cancel
                </button>
              </div>
            )}

            {unorganizedClips.length === 0 ? (
              <p className="text-sm text-muted">
                {clips.length === 0
                  ? 'No clips yet. Upload your first clip to get started.'
                  : 'All clips are assigned to sessions.'}
              </p>
            ) : filteredClips.length === 0 ? (
              <p className="text-sm text-muted">No clips match "{search}".</p>
            ) : (
              <>
                <div className="flex flex-col gap-3">
                  {filteredClips.map(clip => (
                    <ClipCard
                      key={clip.id}
                      clip={clip}
                      onDelete={loadData}
                      selectable={unorganizedClips.length > 1}
                      selected={selectedClipIds.has(clip.id)}
                      onToggle={toggleClipSelect}
                    />
                  ))}
                </div>
                {hasMoreClips && !searchLower && (
                  <div className="mt-4 text-center">
                    <Button variant="secondary" size="sm" onClick={loadMoreClips} disabled={loadingMoreClips}>
                      {loadingMoreClips ? 'Loading...' : 'Load more clips'}
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </AppLayout>
  )
}
