import { useState, useEffect } from 'react'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import SessionCard from '../components/SessionCard'
import UploadButton from '../components/UploadButton'
import { SessionCardSkeleton } from '../components/Skeleton'

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

const PAGE_SIZE = 20

export default function SessionsListPage() {
  const api = useApi()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const [showNewSession, setShowNewSession] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newSport, setNewSport] = useState('boxing')
  const [newType, setNewType] = useState('sparring')
  const [newNotes, setNewNotes] = useState('')
  const [creating, setCreating] = useState(false)

  async function load() {
    try {
      const data = await api.get(`/sessions?limit=${PAGE_SIZE}&offset=0`)
      setSessions(data)
      setOffset(PAGE_SIZE)
      setHasMore(data.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load sessions', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    setLoadingMore(true)
    try {
      const more = await api.get(`/sessions?limit=${PAGE_SIZE}&offset=${offset}`)
      setSessions(prev => [...prev, ...more])
      setOffset(prev => prev + PAGE_SIZE)
      setHasMore(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load more sessions', err)
    } finally {
      setLoadingMore(false)
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
      await load()
    } catch (err) {
      console.error('Failed to create session', err)
    } finally {
      setCreating(false)
    }
  }

  useEffect(() => { load() }, [])

  const searchLower = search.toLowerCase()
  const filtered = searchLower
    ? sessions.filter(s =>
        (s.label || '').toLowerCase().includes(searchLower) ||
        (s.sport || '').toLowerCase().includes(searchLower) ||
        (s.session_type || '').toLowerCase().includes(searchLower)
      )
    : sessions

  return (
    <AppLayout active="sessions">
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Library</p>
            <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text">Sessions</h1>
          </div>
          <UploadButton onUploadComplete={load} />
        </div>

        {/* Search */}
        {sessions.length > 3 && (
          <div className="relative mb-6">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search sessions..."
              className="input pl-9"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">×</button>
            )}
          </div>
        )}

        {/* New session */}
        <div className="mb-5 flex items-center justify-between">
          <h2 className="font-display text-xl font-extrabold uppercase tracking-wide text-text">All sessions</h2>
          <Button variant="secondary" size="sm" onClick={() => setShowNewSession(v => !v)}>
            {showNewSession ? 'Cancel' : '+ New session'}
          </Button>
        </div>

        {showNewSession && (
          <form onSubmit={handleCreateSession} className="mb-5 flex flex-wrap items-end gap-3 rounded-2xl border border-line2 bg-surface p-4">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">Label (optional)</label>
              <input type="text" placeholder="e.g. Saturday sparring" value={newLabel} onChange={e => setNewLabel(e.target.value)} className="input w-48" />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">Sport</label>
              <select value={newSport} onChange={e => setNewSport(e.target.value)} className="input">
                {SPORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">Type</label>
              <select value={newType} onChange={e => setNewType(e.target.value)} className="input">
                {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="flex w-full flex-col gap-1">
              <label className="text-xs text-muted">Notes (optional)</label>
              <input type="text" placeholder="e.g. Working on footwork and combinations" value={newNotes} onChange={e => setNewNotes(e.target.value)} className="input" />
            </div>
            <Button type="submit" size="sm" disabled={creating}>{creating ? 'Creating...' : 'Create'}</Button>
          </form>
        )}

        {loading ? (
          <div className="flex flex-col gap-3">
            {[...Array(4)].map((_, i) => <SessionCardSkeleton key={i} />)}
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted">No sessions yet. Create one above or tag a clip to a session during upload.</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted">No sessions match "{search}".</p>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {filtered.map(session => <SessionCard key={session.id} session={session} />)}
            </div>
            {hasMore && !searchLower && (
              <div className="mt-6 text-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load more sessions'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  )
}
