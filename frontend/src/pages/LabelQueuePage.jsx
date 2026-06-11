import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import { useCurrentUser } from '../hooks/useCurrentUser'
import AppLayout from '../components/AppLayout'
import Tag from '../components/Tag'

export default function LabelQueuePage() {
  const navigate = useNavigate()
  const api = useApi()
  const { user, loading: userLoading } = useCurrentUser()
  const [clips, setClips] = useState(null)

  useEffect(() => {
    if (!userLoading && user && !user.is_admin) navigate('/dashboard', { replace: true })
  }, [user, userLoading])

  useEffect(() => {
    api.get('/admin/label-queue').then(setClips).catch(() => setClips([]))
  }, [])

  const ready = (clips || []).filter(c => c.detections > 0)

  return (
    <AppLayout active="admin">
      <main className="mx-auto max-w-4xl px-4 py-10 md:px-8">
        <p className="text-xs font-bold uppercase tracking-wider text-muted">Admin</p>
        <h1 className="mt-1 font-display text-[34px] font-black leading-none tracking-tight text-text">Label queue</h1>
        <p className="mt-2 max-w-xl text-sm text-text3">
          Verify every detection on a clip, then export it to the golden set with{' '}
          <code className="font-mono text-xs">scripts/export_golden.py</code>. Fully-labeled clips are the ground truth that tunes the classifier.
        </p>

        <div className="mt-8">
          {clips === null ? (
            <p className="animate-pulse text-sm text-muted">Loading…</p>
          ) : ready.length === 0 ? (
            <p className="text-sm text-muted">No processed clips with detections yet.</p>
          ) : (
            ready.map(c => {
              const done = c.labeled >= c.detections
              return (
                <div
                  key={c.id}
                  onClick={() => navigate(`/label/${c.id}`)}
                  className="group flex cursor-pointer items-center gap-4 border-b border-line py-3.5 last:border-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-display text-[17px] font-extrabold text-text">{c.filename}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-text3">
                      {c.created_at && <span>{new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>}
                      {c.clip_type && <Tag tone="muted">{c.clip_type}</Tag>}
                      <span>{c.detections} detections</span>
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-4">
                    <div className="h-[5px] w-28 overflow-hidden rounded-full bg-surface3">
                      <div
                        className="h-full rounded-full transition-all duration-[600ms]"
                        style={{
                          width: `${c.detections ? Math.round((c.labeled / c.detections) * 100) : 0}%`,
                          background: done ? 'var(--color-kiwi)' : 'var(--color-gold)',
                        }}
                      />
                    </div>
                    <span className={`w-16 text-right font-display text-sm font-extrabold tabular-nums ${done ? 'text-kiwi' : 'text-text'}`}>
                      {done ? 'done ✓' : `${c.labeled}/${c.detections}`}
                    </span>
                    <span className="text-xl text-muted transition-colors group-hover:text-kiwi">›</span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </main>
    </AppLayout>
  )
}
