import { useState, useEffect } from 'react'
import { UserButton } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import UploadButton from '../components/UploadButton'
import ClipCard from '../components/ClipCard'
import SessionCard from '../components/SessionCard'
import StatsBar from '../components/StatsBar'

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

  // Trend feedback
  const [trendFeedback, setTrendFeedback] = useState(null)
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendError, setTrendError] = useState(null)

  // New session inline form
  const [showNewSession, setShowNewSession] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newSport, setNewSport] = useState('boxing')
  const [newType, setNewType] = useState('sparring')
  const [creating, setCreating] = useState(false)

  async function loadData() {
    try {
      const [sessionsData, clipsData, userData, statsData] = await Promise.all([
        api.get('/sessions'),
        api.get('/clips'),
        api.get('/users/me'),
        api.get('/users/me/stats'),
      ])
      setSessions(sessionsData)
      setClips(clipsData)
      setStats(statsData)
      setCurrentUser(userData)

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
      })
      setShowNewSession(false)
      setNewLabel('')
      setNewSport('boxing')
      setNewType('sparring')
      await loadData()
    } catch (err) {
      console.error('Failed to create session', err)
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [])

  // Clips not yet assigned to a session
  const unorganizedClips = clips.filter(c => !c.session_id)

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <UserButton />
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-12">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : (
          <>
            <StatsBar stats={stats} />

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
            ) : (
              <div className="flex flex-col gap-4 mb-12">
                {sessions.map(session => (
                  <SessionCard key={session.id} session={session} />
                ))}
              </div>
            )}

            {/* ── Unorganized clips ── */}
            <div className="flex items-center justify-between mb-5">
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

            {unorganizedClips.length === 0 ? (
              <p className="text-gray-500 text-sm">
                {clips.length === 0
                  ? 'No clips yet. Upload your first clip to get started.'
                  : 'All clips are assigned to sessions.'}
              </p>
            ) : (
              <div className="flex flex-col gap-4">
                {unorganizedClips.map(clip => (
                  <ClipCard key={clip.id} clip={clip} onDelete={loadData} />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
