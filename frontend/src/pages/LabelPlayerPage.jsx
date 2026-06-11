import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import { useCurrentUser } from '../hooks/useCurrentUser'
import AppLayout from '../components/AppLayout'
import CanvasPlayer from '../components/CanvasPlayer'

// Pluggable taxonomy — a future defense pass adds an entry here, not a new page.
// Keys must match backend VALID_STRIKE_TYPES (routers/clips.py).
// Kicks are labeled by axis (lead/rear), matching jab/cross for punches — the
// classifier's roundhouse/rear split is normalized to rear_kick at eval time.
const TAXONOMIES = {
  strike: {
    typeKeys: [
      { key: '1', type: 'jab' },
      { key: '2', type: 'cross' },
      { key: '3', type: 'hook' },
      { key: '4', type: 'uppercut' },
      { key: '5', type: 'lead_kick' },
      { key: '6', type: 'rear_kick' },
      { key: '7', type: 'kick' },     // axis unjudgeable (unknown stance footage); switch kicks
                                      // are lead_kick — axis = the fighter's leg, not the slot
                                      // it fired from mid-switch
      { key: '8', type: 'knee' },
      { key: '9', type: 'elbow' },
    ],
  },
}

const WINDOW_BEFORE = 0.6   // seconds of lead-in before the detection
const WINDOW_AFTER = 0.5    // seconds past the detection before the loop wraps
const REVIEW_RATE = 0.5     // slow-mo playback while reviewing
const FRAME = 1 / 30

export default function LabelPlayerPage() {
  const { clipId } = useParams()
  const navigate = useNavigate()
  const api = useApi()
  const { user, loading: userLoading } = useCurrentUser()
  const playerRef = useRef(null)
  const taxonomy = TAXONOMIES.strike

  const [clip, setClip] = useState(null)
  const [strikes, setStrikes] = useState([])
  const [verdicts, setVerdicts] = useState({})   // strike_id → {label, corrected_type}
  const [missed, setMissed] = useState([])       // [{timestamp_seconds, corrected_type}]
  const [idx, setIdx] = useState(0)
  const [missedArm, setMissedArm] = useState(false)
  const [looping, setLooping] = useState(true)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  // refs so the global keydown handler always sees current state
  const stateRef = useRef({})
  stateRef.current = { strikes, idx, verdicts, missedArm, looping }

  useEffect(() => {
    if (!userLoading && user && !user.is_admin) navigate('/dashboard', { replace: true })
  }, [user, userLoading])

  useEffect(() => {
    async function load() {
      try {
        const [clipData, strikesData, labelsData] = await Promise.all([
          api.get(`/clips/${clipId}`),
          api.get(`/clips/${clipId}/strikes`),
          api.get(`/admin/clips/${clipId}/strike-labels`),
        ])
        setClip(clipData)
        const ordered = (Array.isArray(strikesData) ? strikesData : [])
          .sort((a, b) => a.timestamp_seconds - b.timestamp_seconds)
        setStrikes(ordered)
        setVerdicts(labelsData.verdicts || {})
        setMissed(labelsData.missed || [])
        // resume at the first unlabeled detection
        const firstOpen = ordered.findIndex(s => !(labelsData.verdicts || {})[s.id])
        setIdx(firstOpen === -1 ? 0 : firstOpen)
      } catch {
        setError('Failed to load clip for labeling')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [clipId])

  // Review loop: slow-mo around the current detection, wrap when past the window
  useEffect(() => {
    const strike = strikes[idx]
    const p = playerRef.current
    if (!strike || !p) return
    const t = strike.timestamp_seconds
    p.setPlaybackRate(REVIEW_RATE)
    p.seekTo(Math.max(0, t - WINDOW_BEFORE))
    p.play()
    const interval = setInterval(() => {
      if (!stateRef.current.looping) return
      const now = playerRef.current?.getCurrentTime() ?? 0
      if (now > t + WINDOW_AFTER) playerRef.current?.seekTo(Math.max(0, t - WINDOW_BEFORE))
    }, 80)
    return () => clearInterval(interval)
  }, [idx, strikes])

  function nextOpen(from) {
    const { strikes: s, verdicts: v } = stateRef.current
    for (let i = from + 1; i < s.length; i++) if (!v[s[i].id]) return i
    for (let i = 0; i < s.length; i++) if (!v[s[i].id]) return i
    return Math.min(from + 1, s.length - 1)
  }

  async function verdict(strike, label, correctedType = null) {
    setVerdicts(prev => ({ ...prev, [strike.id]: { label, corrected_type: correctedType } }))
    setIdx(i => nextOpen(i))
    try {
      await api.post(`/clips/${clipId}/strike-labels`, {
        strike_id: strike.id,
        label,
        corrected_type: correctedType,
        timestamp_seconds: strike.timestamp_seconds,
      })
    } catch {
      setVerdicts(prev => { const next = { ...prev }; delete next[strike.id]; return next })
    }
  }

  async function addMissed(type) {
    const t = playerRef.current?.getCurrentTime() ?? 0
    setMissedArm(false)
    try {
      const res = await api.post(`/clips/${clipId}/strike-labels`, {
        label: 'missed',
        corrected_type: type,
        timestamp_seconds: t,
      })
      setMissed(prev => [...prev, { id: res.id, timestamp_seconds: t, corrected_type: type }]
        .sort((a, b) => a.timestamp_seconds - b.timestamp_seconds))
    } catch (err) {
      console.error('Failed to record missed strike', err)
    }
  }

  async function removeMissed(mark) {
    setMissed(prev => prev.filter(m => m.id !== mark.id))
    try {
      await api.delete(`/clips/${clipId}/strike-labels/${mark.id}`)
    } catch (err) {
      console.error('Failed to remove missed strike', err)
      setMissed(prev => [...prev, mark].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds))
    }
  }

  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const { strikes: s, idx: i, missedArm: armed } = stateRef.current
      const strike = s[i]
      const typeKey = taxonomy.typeKeys.find(k => k.key === e.key)

      if (armed) {
        if (typeKey) { e.preventDefault(); addMissed(typeKey.type) }
        else if (e.key === 'Escape') setMissedArm(false)
        return
      }
      if (!strike) return

      if (e.key === 'y') { e.preventDefault(); verdict(strike, 'correct') }
      else if (e.key === 'n') { e.preventDefault(); verdict(strike, 'not_a_strike') }
      else if (typeKey) {
        e.preventDefault()
        if (typeKey.type === strike.type) verdict(strike, 'correct')
        else verdict(strike, 'wrong_type', typeKey.type)
      }
      else if (e.key === 'm') { e.preventDefault(); setLooping(false); playerRef.current?.pause(); setMissedArm(true) }
      else if (e.key === ' ') {
        e.preventDefault()
        setLooping(l => {
          if (l) playerRef.current?.pause(); else playerRef.current?.play()
          return !l
        })
      }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        setLooping(false)
        playerRef.current?.pause()
        const now = playerRef.current?.getCurrentTime() ?? 0
        playerRef.current?.seekTo(Math.max(0, now + (e.key === 'ArrowRight' ? FRAME : -FRAME)))
      }
      else if (e.key === 'j' || e.key === 'ArrowUp') { e.preventDefault(); setLooping(true); setIdx(x => Math.max(0, x - 1)) }
      else if (e.key === 'k' || e.key === 'ArrowDown') { e.preventDefault(); setLooping(true); setIdx(x => Math.min(s.length - 1, x + 1)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (loading || userLoading) {
    return <AppLayout active="admin"><main className="px-8 py-10"><p className="animate-pulse text-sm text-muted">Loading…</p></main></AppLayout>
  }
  if (error || !clip) {
    return <AppLayout active="admin"><main className="px-8 py-10"><p className="text-sm text-danger">{error || 'Clip not found.'}</p></main></AppLayout>
  }

  const labeled = strikes.filter(s => verdicts[s.id]).length
  const done = strikes.length > 0 && labeled === strikes.length
  const current = strikes[idx]

  return (
    <AppLayout active="admin">
      <div className="border-b border-line bg-surface px-4 py-4 md:px-8">
        <button onClick={() => navigate('/label')} className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted transition-colors hover:text-text">
          ← Label queue
        </button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-xl font-black tracking-tight text-text">{clip.filename}</h1>
          <div className="flex items-center gap-3">
            {missedArm && <span className="animate-pulse text-xs font-bold uppercase tracking-wide text-warning">press a type key to mark missed strike — esc cancels</span>}
            <span className={`font-display text-base font-extrabold tabular-nums ${done ? 'text-kiwi' : 'text-text'}`}>
              {labeled}/{strikes.length} verified{missed.length > 0 ? ` · +${missed.length} missed` : ''}
            </span>
          </div>
        </div>
        {done ? (
          <p className="mt-2 rounded-lg border border-kiwi bg-surface2 px-3 py-2 text-xs text-kiwi">
            Clip fully labeled ✓ — export with:&nbsp;
            <code className="select-all font-mono">./venv/bin/python scripts/export_golden.py {clipId} golden/</code>
          </p>
        ) : labeled > 0 && (
          <p className="mt-2 text-[11px] text-muted">
            Export:&nbsp;
            <code className="select-all font-mono text-text3">./venv/bin/python scripts/export_golden.py {clipId} golden/</code>
            &nbsp;— append a cutoff in seconds to export a partially-labeled clip (e.g. tracking switches subjects mid-clip).
          </p>
        )}
      </div>

      <div className="flex flex-col xl:flex-row">
        <main className="min-w-0 flex-1 p-4 md:p-6">
          <CanvasPlayer ref={playerRef} videoUrl={clip.video_url} resultUrl={clip.result_url} />
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
            <span><Key>y</Key> correct</span>
            <span><Key>n</Key> not a strike</span>
            {taxonomy.typeKeys.map(k => <span key={k.key}><Key>{k.key}</Key> {k.type.replace('_', ' ')}</span>)}
            <span><Key>m</Key> missed strike</span>
            <span><Key>space</Key> pause loop</span>
            <span><Key>←→</Key> frame step</span>
            <span><Key>j/k</Key> prev/next</span>
          </div>
        </main>

        <aside className="border-t border-line xl:w-[300px] xl:flex-shrink-0 xl:border-l xl:border-t-0">
          <div className="max-h-[70vh] overflow-y-auto p-3">
            {strikes.map((s, i) => {
              const v = verdicts[s.id]
              return (
                <button
                  key={s.id}
                  onClick={() => { setLooping(true); setIdx(i) }}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    i === idx ? 'bg-surface2 ring-1 ring-kiwi' : 'hover:bg-surface2'
                  }`}
                >
                  <span className="w-10 flex-shrink-0 font-mono text-[11px] tabular-nums text-muted">{s.timestamp_seconds.toFixed(1)}s</span>
                  <span className="flex-1 truncate text-[13px] capitalize text-text">
                    {s.type.replace('_', ' ')}
                    {v?.label === 'wrong_type' && <span className="text-warning"> → {v.corrected_type.replace('_', ' ')}</span>}
                  </span>
                  <span className="flex-shrink-0 font-display text-sm font-extrabold">
                    {!v ? <span className="text-muted">·</span>
                      : v.label === 'correct' ? <span className="text-kiwi">✓</span>
                      : v.label === 'not_a_strike' ? <span className="text-danger">✗</span>
                      : <span className="text-warning">≠</span>}
                  </span>
                </button>
              )
            })}
            {strikes.length === 0 && <p className="p-2 text-sm text-muted">No detections on this clip.</p>}
          </div>
          {missed.length > 0 && (
            <div className="border-t border-line p-3">
              <p className="mb-1.5 px-2.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                Missed strikes you added ({missed.length})
              </p>
              {missed.map(m => (
                <div key={m.id || m.timestamp_seconds} className="group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 hover:bg-surface2">
                  <button
                    onClick={() => { setLooping(false); playerRef.current?.pause(); playerRef.current?.seekTo(m.timestamp_seconds) }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <span className="w-10 flex-shrink-0 font-mono text-[11px] tabular-nums text-muted">{m.timestamp_seconds.toFixed(1)}s</span>
                    <span className="truncate text-[13px] capitalize text-warning">+ {m.corrected_type?.replace('_', ' ')}</span>
                  </button>
                  {m.id && (
                    <button
                      onClick={() => removeMissed(m)}
                      className="flex-shrink-0 px-1 font-display text-base font-bold text-muted transition-colors hover:text-danger"
                      title="Remove this mark"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          {current && (
            <div className="border-t border-line p-3 text-[11px] text-muted">
              Reviewing #{idx + 1}: <span className="capitalize text-text">{current.type.replace('_', ' ')}</span> at {current.timestamp_seconds.toFixed(2)}s
              {current.confidence != null && <> · conf {current.confidence.toFixed(2)}</>}
            </div>
          )}
        </aside>
      </div>
    </AppLayout>
  )
}

function Key({ children }) {
  return <kbd className="rounded border border-line2 bg-surface2 px-1 font-mono text-[10px] text-text2">{children}</kbd>
}
