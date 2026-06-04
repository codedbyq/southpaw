import { useState, useEffect } from 'react'
import { useApi } from '../api/client'

export default function RequestReviewModal({ coach, currentUser, onClose, onSuccess }) {
  const api = useApi()

  // Default tab based on coach preference
  const defaultTab = coach.review_preference === 'session' ? 'session' : 'clip'
  const [tab, setTab] = useState(defaultTab)

  const [clips, setClips] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedClip, setSelectedClip] = useState(null)
  const [selectedSession, setSelectedSession] = useState(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const [clipsData, sessionsData] = await Promise.all([
          api.get('/clips'),
          api.get('/sessions'),
        ])
        setClips(clipsData.filter(c => c.job?.status === 'complete'))
        setSessions(sessionsData)
      } catch (err) {
        console.error('Failed to load', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  async function handleSubmit() {
    const hasSelection = tab === 'clip' ? selectedClip : selectedSession
    if (!hasSelection) return
    setSubmitting(true)
    setError(null)
    try {
      await api.post('/reviews', {
        coach_profile_id: coach.id,
        clip_id: tab === 'clip' ? selectedClip.id : null,
        session_id: tab === 'session' ? selectedSession.id : null,
        athlete_note: note || null,
      })
      onSuccess()
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  const canAfford = currentUser && currentUser.credits_balance >= coach.credit_rate
  const hasSelection = tab === 'clip' ? selectedClip : selectedSession
  const showBothTabs = coach.review_preference === 'either'

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 px-4">
      <div className="bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="font-semibold text-white">Request a review</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              from {coach.display_name || 'Coach'} · {coach.credit_rate} credits
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Credits check */}
        {currentUser && (
          <div className={`mx-5 mt-4 px-4 py-2.5 rounded-lg text-sm flex items-center justify-between ${
            canAfford ? 'bg-gray-800 text-gray-300' : 'bg-red-950 border border-red-800 text-red-400'
          }`}>
            <span>Your balance: <span className="font-medium text-white">{currentUser.credits_balance} credits</span></span>
            {!canAfford && <span>Insufficient credits</span>}
          </div>
        )}

        {/* Tabs — only show both if coach accepts either */}
        {showBothTabs && (
          <div className="flex gap-2 px-5 pt-4">
            {[
              { key: 'clip', label: 'Clip' },
              { key: 'session', label: 'Session' },
            ].map(t => (
              <button
                key={t.key}
                onClick={() => { setTab(t.key); setSelectedClip(null); setSelectedSession(null) }}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === t.key
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Preference hint when not "either" */}
        {!showBothTabs && (
          <p className="px-5 pt-4 text-xs text-gray-500">
            {coach.review_preference === 'clip'
              ? '📎 This coach prefers individual clip reviews'
              : '📁 This coach prefers full session reviews'}
          </p>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-xs text-gray-500 uppercase tracking-wide mb-3">
            {tab === 'clip' ? 'Select a clip' : 'Select a session'}
          </p>

          {loading ? (
            <p className="text-gray-500 text-sm">Loading...</p>
          ) : tab === 'clip' ? (
            clips.length === 0 ? (
              <p className="text-gray-500 text-sm">No processed clips yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {clips.map(clip => (
                  <button
                    key={clip.id}
                    onClick={() => setSelectedClip(clip)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedClip?.id === clip.id
                        ? 'border-indigo-500 bg-indigo-950'
                        : 'border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="w-14 h-10 rounded-lg bg-gray-800 flex-shrink-0 overflow-hidden">
                      {clip.thumbnail_url
                        ? <img src={clip.thumbnail_url} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-gray-600 text-xs">🎬</div>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{clip.filename}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {clip.sport} · {new Date(clip.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    {selectedClip?.id === clip.id && (
                      <div className="w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )
          ) : (
            sessions.length === 0 ? (
              <p className="text-gray-500 text-sm">No sessions yet. Create a session first.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => setSelectedSession(session)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedSession?.id === session.id
                        ? 'border-indigo-500 bg-indigo-950'
                        : 'border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-gray-800 flex-shrink-0 flex items-center justify-center text-xl">
                      📁
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white truncate">{session.label || 'Untitled session'}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {session.sport} · {session.clip_count ?? 0} clip{session.clip_count !== 1 ? 's' : ''} · {new Date(session.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    {selectedSession?.id === session.id && (
                      <div className="w-4 h-4 rounded-full bg-indigo-500 flex items-center justify-center flex-shrink-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-white" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )
          )}

          {/* Note */}
          {hasSelection && (
            <div className="mt-4">
              <label className="text-xs text-gray-500 uppercase tracking-wide mb-2 block">
                Note for coach (optional)
              </label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. Focus on my guard discipline in the second round..."
                rows={2}
                className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-800 flex items-center justify-between gap-3">
          {error && <p className="text-red-400 text-xs flex-1">{error}</p>}
          <div className="flex gap-2 ml-auto">
            <button onClick={onClose}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!hasSelection || !canAfford || submitting}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {submitting ? 'Sending...' : `Send · ${coach.credit_rate} credits`}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
