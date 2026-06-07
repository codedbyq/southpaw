import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useUser } from '@clerk/react'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import UploadButton from '../components/UploadButton'
import SessionCard from '../components/SessionCard'
import StatsBar from '../components/StatsBar'
import CoachReviewPanel from '../components/CoachReviewPanel'
import { StatsBarSkeleton, SessionCardSkeleton } from '../components/Skeleton'

const RECENT_LIMIT = 4

export default function DashboardPage() {
  const api = useApi()
  const navigate = useNavigate()
  const { user: clerkUser } = useUser()

  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState(null)
  const [currentUser, setCurrentUser] = useState(null)
  const [hasCoachProfile, setHasCoachProfile] = useState(null)
  const [paymentBanner, setPaymentBanner] = useState(null) // 'success' | 'cancelled'

  // Trend feedback
  const [trendFeedback, setTrendFeedback] = useState(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendError, setTrendError] = useState(null)

  async function loadData() {
    try {
      const [sessionsData, userData, statsData] = await Promise.all([
        api.get(`/sessions?limit=${RECENT_LIMIT}&offset=0`),
        api.get('/users/me'),
        api.get('/users/me/stats'),
      ])
      setSessions(sessionsData)
      setStats(statsData)
      setCurrentUser(userData)

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

  useEffect(() => {
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

  const hour = new Date().getHours()
  const partOfDay = hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const greeting = clerkUser?.firstName ? `Good ${partOfDay}, ${clerkUser.firstName}` : `Good ${partOfDay}`
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <AppLayout active="dashboard">
      <div className="flex">
        <div className="min-w-0 flex-1">
          <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
            {/* ── Greeting header ── */}
            <div className="mb-8 flex items-start justify-between gap-4">
              <div>
                <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">{today}</p>
                <h1 className="mt-1 font-display text-[32px] font-extrabold leading-tight text-text">{greeting}</h1>
              </div>
              <UploadButton onUploadComplete={loadData} />
            </div>

            {paymentBanner && (
              <div className={`mb-6 flex items-center justify-between rounded-2xl p-4 ${
                paymentBanner === 'success' ? 'border border-kiwi/40 bg-kiwi/8' : 'border border-line bg-surface'
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
                    <Button size="sm" onClick={() => navigate('/profile')} className="ml-6 flex-shrink-0">Set up profile</Button>
                  </div>
                )}

                {/* ── Trend Feedback ── */}
                {sessions.length >= 1 && (
                  <div className="relative mb-10 overflow-hidden rounded-2xl border border-line bg-surface p-5">
                    <span className="absolute inset-y-0 left-0 w-[3px] bg-kiwi" />
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-kiwi/10 text-kiwi">◈</span>
                        <div>
                          <h2 className="font-display text-lg font-extrabold uppercase tracking-wide text-text">Progress analysis</h2>
                          <p className="mt-0.5 text-xs text-muted">AI coaching trends across your last sessions</p>
                        </div>
                      </div>
                      {sessions.length >= 2 && (
                        <Button size="sm" onClick={handleTrendFeedback} disabled={trendLoading}>
                          {trendLoading ? 'Analysing...' : trendFeedback ? 'Refresh' : 'Analyse progress'}
                        </Button>
                      )}
                    </div>

                    {sessions.length < 2 ? (
                      <p className="text-sm text-muted">1 more session needed to unlock progress analysis.</p>
                    ) : trendError ? (
                      <p className="text-sm text-danger">{trendError}</p>
                    ) : trendFeedback && !trendLoading ? (
                      <div>
                        <p className="mb-3 text-xs text-muted">Based on {trendFeedback.session_count} sessions</p>
                        <div className="whitespace-pre-wrap text-sm leading-relaxed text-text2">{trendFeedback.feedback}</div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted">Click analyse to see how your training has progressed over time.</p>
                    )}
                  </div>
                )}

                {/* ── Recent sessions ── */}
                <div className="mb-5 flex items-center justify-between">
                  <h2 className="font-display text-xl font-extrabold uppercase tracking-wide text-text">Recent sessions</h2>
                  <Link to="/sessions" className="text-sm font-semibold text-kiwi transition-colors hover:text-kiwi-bright">
                    View all →
                  </Link>
                </div>

                {sessions.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-line bg-surface p-8 text-center">
                    <p className="font-display text-lg font-bold text-text">No sessions yet</p>
                    <p className="mt-1 text-sm text-muted">Upload a clip to start your first session.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {sessions.slice(0, RECENT_LIMIT).map(session => (
                      <SessionCard key={session.id} session={session} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {currentUser?.user_type === 'coach' && (
          <aside className="sticky top-0 hidden h-screen w-[320px] flex-shrink-0 self-start xl:block">
            <CoachReviewPanel />
          </aside>
        )}
      </div>
    </AppLayout>
  )
}
