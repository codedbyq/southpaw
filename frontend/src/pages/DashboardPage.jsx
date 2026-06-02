import { useState, useEffect } from 'react'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import UploadButton from '../components/UploadButton'
import ClipCard from '../components/ClipCard'
import SessionCard from '../components/SessionCard'

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
  const [sessions, setSessions] = useState([])
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)

  // New session inline form
  const [showNewSession, setShowNewSession] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newSport, setNewSport] = useState('boxing')
  const [newType, setNewType] = useState('sparring')
  const [creating, setCreating] = useState(false)

  async function loadData() {
    try {
      const [sessionsData, clipsData] = await Promise.all([
        api.get('/sessions'),
        api.get('/clips'),
      ])
      setSessions(sessionsData)
      setClips(clipsData)
    } catch (err) {
      console.error('Failed to load dashboard', err)
    } finally {
      setLoading(false)
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
