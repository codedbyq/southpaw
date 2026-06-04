import { useState, useEffect } from 'react'
import { UserButton } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import UploadButton from '../components/UploadButton'
import ClipCard from '../components/ClipCard'
import SessionCard from '../components/SessionCard'
import StatsBar from '../components/StatsBar'
import { StatsBarSkeleton, SessionCardSkeleton, ClipCardSkeleton } from '../components/Skeleton'
import BuyCreditsModal from '../components/BuyCreditsModal'
import NotificationBell from '../components/NotificationBell'
import StarRating from '../components/StarRating'

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
  const [showBuyCredits, setShowBuyCredits] = useState(false)
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

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <div className="flex items-center gap-4">
          <button onClick={() => navigate('/coaches')} className="text-sm text-gray-400 hover:text-white transition-colors">
            Find a coach
          </button>
          {currentUser?.user_type === 'coach' && (
            <button onClick={() => navigate('/reviews/queue')} className="text-sm text-gray-400 hover:text-white transition-colors">
              Review queue
            </button>
          )}
          {currentUser?.is_admin && (
            <button onClick={() => navigate('/admin')} className="text-sm text-amber-500 hover:text-amber-400 transition-colors">
              Admin
            </button>
          )}
          {currentUser && (
            <div className="flex items-center gap-2">
              {currentUser.subscription_tier !== 'free' && (
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                  currentUser.subscription_tier === 'elite'
                    ? 'bg-yellow-900 text-yellow-400'
                    : 'bg-indigo-900 text-indigo-400'
                }`}>
                  {currentUser.subscription_tier === 'elite' ? 'Elite' : 'Pro'}
                </span>
              )}
              <button
                onClick={() => setShowBuyCredits(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
              >
                <span className="text-yellow-400">⚡</span>
                {currentUser.credits_balance} credits
              </button>
            </div>
          )}
          <NotificationBell />
          <UserButton />
        </div>
      </nav>

      {showBuyCredits && (
        <BuyCreditsModal
          onClose={() => setShowBuyCredits(false)}
        />
      )}

      <main className="max-w-4xl mx-auto px-6 py-12">
        {paymentBanner && (
          <div className={`mb-6 p-4 rounded-xl flex items-center justify-between ${
            paymentBanner === 'success'
              ? 'bg-green-950 border border-green-800'
              : 'bg-gray-900 border border-gray-800'
          }`}>
            <p className={`text-sm font-medium ${paymentBanner === 'success' ? 'text-green-400' : 'text-gray-400'}`}>
              {paymentBanner === 'success'
                ? '✓ Payment successful — your credits have been added'
                : 'Payment cancelled — no charge was made'}
            </p>
            <button onClick={() => setPaymentBanner(null)} className="text-gray-600 hover:text-white ml-4">×</button>
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
              <div className="mb-6 p-4 bg-gray-900 border border-gray-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-sm text-white font-medium">You're on the Free plan</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    3 clips/month · Upgrade for unlimited clips, session feedback and more credits
                  </p>
                </div>
                <button
                  onClick={() => navigate('/pricing')}
                  className="ml-6 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
                >
                  Upgrade
                </button>
              </div>
            )}

            {/* ── Coach profile prompt ── */}
            {currentUser?.user_type === 'coach' && hasCoachProfile === false && (
              <div className="mb-8 p-5 bg-indigo-950 border border-indigo-800 rounded-xl flex items-center justify-between">
                <div>
                  <p className="text-white font-medium text-sm">Set up your coach profile</p>
                  <p className="text-indigo-300 text-xs mt-0.5">
                    Add your bio, specializations, and credit rate to appear in the marketplace.
                  </p>
                </div>
                <button
                  onClick={() => navigate('/coach/profile')}
                  className="ml-6 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors flex-shrink-0"
                >
                  Set up profile
                </button>
              </div>
            )}

            {/* ── Coach profile link (profile exists) ── */}
            {currentUser?.user_type === 'coach' && hasCoachProfile === true && (
              <div className="mb-8 flex justify-end">
                <button
                  onClick={() => navigate('/coach/profile')}
                  className="text-sm text-gray-500 hover:text-white transition-colors"
                >
                  Edit coach profile →
                </button>
              </div>
            )}

            {/* ── Trend Feedback ── */}
            {sessions.length >= 1 && (
              <div className="mb-10 p-5 bg-gray-900 border border-gray-800 rounded-xl">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h2 className="text-lg font-semibold text-white">Progress analysis</h2>
                    <p className="text-xs text-gray-500 mt-0.5">AI coaching trends across your last sessions</p>
                  </div>
                  {sessions.length >= 2 && (
                    <button
                      onClick={handleTrendFeedback}
                      disabled={trendLoading}
                      className="text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                    >
                      {trendLoading ? 'Analysing...' : trendFeedback ? 'Refresh' : 'Analyse progress'}
                    </button>
                  )}
                </div>

                {sessions.length < 2 ? (
                  <p className="text-sm text-gray-500">
                    1 more session needed to unlock progress analysis.
                  </p>
                ) : trendError ? (
                  <p className="text-red-400 text-sm">{trendError}</p>
                ) : trendFeedback && !trendLoading ? (
                  <div>
                    <p className="text-xs text-gray-500 mb-3">
                      Based on {trendFeedback.session_count} sessions
                    </p>
                    <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                      {trendFeedback.feedback}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">
                    Click analyse to see how your training has progressed over time.
                  </p>
                )}
              </div>
            )}

            {/* ── Pending reviews ── */}
            {athleteReviews.filter(r => r.status !== 'cancelled').length > 0 && (
              <div className="mb-10">
                <h2 className="text-xl font-semibold mb-4">Coach reviews</h2>
                <div className="flex flex-col gap-3">
                  {athleteReviews.filter(r => r.status !== 'cancelled').map(review => (
                    <div key={review.id} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
                      <div
                        onClick={() => review.clip_id && navigate(`/clips/${review.clip_id}`)}
                        className={`flex items-center gap-4 p-4 transition-colors ${review.clip_id ? 'cursor-pointer hover:bg-gray-800/50' : ''}`}
                      >
                        <div className="w-14 h-10 rounded-lg bg-gray-800 flex-shrink-0 overflow-hidden">
                          {review.clip_thumbnail_url
                            ? <img src={review.clip_thumbnail_url} alt="" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">🎬</div>
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-white truncate">{review.clip_filename || 'Clip'}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {review.coach_display_name || 'Coach'} · {review.credits_cost} credits
                          </p>
                        </div>
                        <span className={`text-xs px-2.5 py-1 rounded-full font-medium flex-shrink-0 ${
                          review.status === 'complete' ? 'bg-green-900 text-green-400' :
                          review.status === 'in_review' ? 'bg-blue-900 text-blue-400' :
                          'bg-yellow-900 text-yellow-400'
                        }`}>
                          {review.status === 'complete' ? 'Complete' :
                           review.status === 'in_review' ? 'In review' : 'Pending'}
                        </span>
                      </div>

                      {/* Rating row — only for complete reviews */}
                      {review.status === 'complete' && (
                        <div className="px-4 pb-3 flex items-center gap-3 border-t border-gray-800/60 pt-3">
                          {review.athlete_rating ? (
                            <>
                              <span className="text-xs text-gray-500">Your rating:</span>
                              <StarRating value={review.athlete_rating} readonly size="sm" />
                            </>
                          ) : (
                            <>
                              <span className="text-xs text-gray-500">Rate this review:</span>
                              <StarRating
                                value={null}
                                size="sm"
                                onChange={rating => handleRateReview(review.id, rating)}
                              />
                              {ratingLoading === review.id && (
                                <span className="text-xs text-gray-500">Saving...</span>
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
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search sessions and clips..."
                  className="w-full pl-9 pr-4 py-2.5 bg-gray-900 border border-gray-800 rounded-xl text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-white"
                  >
                    ×
                  </button>
                )}
              </div>
            )}

            {/* ── Sessions ── */}
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-xl font-semibold">Your sessions</h2>
              <button
                onClick={() => setShowNewSession(v => !v)}
                className="text-sm px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors"
              >
                {showNewSession ? 'Cancel' : '+ New session'}
              </button>
            </div>

            {showNewSession && (
              <form
                onSubmit={handleCreateSession}
                className="mb-5 p-4 bg-gray-900 border border-gray-700 rounded-xl flex flex-wrap gap-3 items-end"
              >
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500">Label (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Saturday sparring"
                    value={newLabel}
                    onChange={e => setNewLabel(e.target.value)}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg w-48"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500">Sport</label>
                  <select
                    value={newSport}
                    onChange={e => setNewSport(e.target.value)}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg"
                  >
                    {SPORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs text-gray-500">Type</label>
                  <select
                    value={newType}
                    onChange={e => setNewType(e.target.value)}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg"
                  >
                    {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div className="flex flex-col gap-1 w-full">
                  <label className="text-xs text-gray-500">Notes (optional)</label>
                  <input
                    type="text"
                    placeholder="e.g. Working on footwork and combinations"
                    value={newNotes}
                    onChange={e => setNewNotes(e.target.value)}
                    className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg w-full"
                  />
                </div>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {creating ? 'Creating...' : 'Create'}
                </button>
              </form>
            )}

            {sessions.length === 0 ? (
              <p className="text-gray-500 text-sm mb-12">
                No sessions yet. Create one above or tag a clip to a session during upload.
              </p>
            ) : filteredSessions.length === 0 ? (
              <p className="text-gray-500 text-sm mb-12">No sessions match "{search}".</p>
            ) : (
              <>
                <div className="flex flex-col gap-4 mb-4">
                  {filteredSessions.map(session => (
                    <SessionCard key={session.id} session={session} />
                  ))}
                </div>
                {hasMoreSessions && !searchLower && (
                  <div className="mb-8 text-center">
                    <button
                      onClick={loadMoreSessions}
                      disabled={loadingMoreSessions}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {loadingMoreSessions ? 'Loading...' : 'Load more sessions'}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* ── Unorganized clips ── */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xl font-semibold">
                Unorganized clips
                {unorganizedClips.length > 0 && (
                  <span className="ml-2 text-sm font-normal text-gray-500">
                    {unorganizedClips.length}
                  </span>
                )}
              </h2>
              <UploadButton onUploadComplete={loadData} />
            </div>

            {/* Select all row */}
            {unorganizedClips.length > 1 && (
              <div className="flex items-center gap-3 mb-3">
                <button
                  onClick={toggleSelectAll}
                  className="text-xs text-gray-500 hover:text-white transition-colors"
                >
                  {selectedClipIds.size === unorganizedClips.length ? 'Deselect all' : 'Select all'}
                </button>
                {selectedClipIds.size > 0 && (
                  <span className="text-xs text-gray-600">
                    {selectedClipIds.size} selected
                  </span>
                )}
              </div>
            )}

            {/* Bulk action bar */}
            {selectedClipIds.size > 0 && (
              <div className="flex items-center gap-3 mb-4 p-3 bg-gray-900 border border-gray-700 rounded-xl">
                <select
                  value={bulkSessionId}
                  onChange={e => setBulkSessionId(e.target.value)}
                  className="flex-1 px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg focus:outline-none"
                >
                  <option value="">Assign to session...</option>
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.label || `${s.session_type || 'Session'}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={handleBulkAssign}
                  disabled={!bulkSessionId || bulkLoading}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {bulkLoading ? 'Moving...' : 'Assign'}
                </button>
                <button
                  onClick={handleBulkDelete}
                  disabled={bulkLoading}
                  className="px-3 py-1.5 bg-red-900 hover:bg-red-800 disabled:opacity-40 text-red-300 text-xs font-medium rounded-lg transition-colors"
                >
                  Delete {selectedClipIds.size}
                </button>
                <button
                  onClick={() => setSelectedClipIds(new Set())}
                  className="text-xs text-gray-500 hover:text-white transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}

            {unorganizedClips.length === 0 ? (
              <p className="text-gray-500 text-sm">
                {clips.length === 0
                  ? 'No clips yet. Upload your first clip to get started.'
                  : 'All clips are assigned to sessions.'}
              </p>
            ) : filteredClips.length === 0 ? (
              <p className="text-gray-500 text-sm">No clips match "{search}".</p>
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
                    <button
                      onClick={loadMoreClips}
                      disabled={loadingMoreClips}
                      className="px-4 py-2 text-sm text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {loadingMoreClips ? 'Loading...' : 'Load more clips'}
                    </button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
