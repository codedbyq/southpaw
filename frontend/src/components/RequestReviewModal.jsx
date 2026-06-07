import { useState, useEffect } from 'react'
import { useApi } from '../api/client'
import Button from './Button'

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
      <div className="bg-surface border border-line rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-line">
          <div>
            <h2 className="font-display font-extrabold uppercase tracking-wide text-text">Request a review</h2>
            <p className="text-xs text-muted mt-0.5">
              from {coach.display_name || 'Coach'} · {coach.credit_rate} credits
            </p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">×</button>
        </div>

        {/* Credits check */}
        {currentUser && (
          <div className={`mx-5 mt-4 px-4 py-2.5 rounded-lg text-sm flex items-center justify-between ${
            canAfford ? 'bg-surface2 text-text2' : 'bg-danger/10 border border-danger/40 text-danger'
          }`}>
            <span>Your balance: <span className="font-medium text-text">{currentUser.credits_balance} credits</span></span>
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
                className={`chip ${tab === t.key ? 'active' : ''}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}

        {/* Preference hint when not "either" */}
        {!showBothTabs && (
          <p className="px-5 pt-4 text-xs text-muted">
            {coach.review_preference === 'clip'
              ? '📎 This coach prefers individual clip reviews'
              : '📁 This coach prefers full session reviews'}
          </p>
        )}

        {/* List */}
        <div className="flex-1 overflow-y-auto p-5">
          <p className="text-xs text-muted uppercase tracking-wide mb-3">
            {tab === 'clip' ? 'Select a clip' : 'Select a session'}
          </p>

          {loading ? (
            <p className="text-muted text-sm">Loading...</p>
          ) : tab === 'clip' ? (
            clips.length === 0 ? (
              <p className="text-muted text-sm">No processed clips yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {clips.map(clip => (
                  <button
                    key={clip.id}
                    onClick={() => setSelectedClip(clip)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedClip?.id === clip.id
                        ? 'border-kiwi bg-kiwi/8'
                        : 'border-line hover:border-line2'
                    }`}
                  >
                    <div className="w-14 h-10 rounded-lg bg-surface3 flex-shrink-0 overflow-hidden">
                      {clip.thumbnail_url
                        ? <img src={clip.thumbnail_url} alt="" className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex items-center justify-center text-muted text-xs">🎬</div>
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text truncate">{clip.filename}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {clip.sport} · {new Date(clip.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    {selectedClip?.id === clip.id && (
                      <div className="w-4 h-4 rounded-full bg-kiwi flex items-center justify-center flex-shrink-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-black" />
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )
          ) : (
            sessions.length === 0 ? (
              <p className="text-muted text-sm">No sessions yet. Create a session first.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {sessions.map(session => (
                  <button
                    key={session.id}
                    onClick={() => setSelectedSession(session)}
                    className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedSession?.id === session.id
                        ? 'border-kiwi bg-kiwi/8'
                        : 'border-line hover:border-line2'
                    }`}
                  >
                    <div className="w-10 h-10 rounded-lg bg-surface3 flex-shrink-0 flex items-center justify-center text-xl">
                      📁
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text truncate">{session.label || 'Untitled session'}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {session.sport} · {session.clip_count ?? 0} clip{session.clip_count !== 1 ? 's' : ''} · {new Date(session.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </p>
                    </div>
                    {selectedSession?.id === session.id && (
                      <div className="w-4 h-4 rounded-full bg-kiwi flex items-center justify-center flex-shrink-0">
                        <div className="w-1.5 h-1.5 rounded-full bg-black" />
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
              <label className="text-xs text-muted uppercase tracking-wide mb-2 block">
                Note for coach (optional)
              </label>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. Focus on my guard discipline in the second round..."
                rows={2}
                className="input resize-none"
              />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-line flex items-center justify-between gap-3">
          {error && <p className="text-danger text-xs flex-1">{error}</p>}
          <div className="flex gap-2 ml-auto">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSubmit} disabled={!hasSelection || !canAfford || submitting}>
              {submitting ? 'Sending...' : `Send · ${coach.credit_rate} credits`}
            </Button>
          </div>
        </div>

      </div>
    </div>
  )
}
