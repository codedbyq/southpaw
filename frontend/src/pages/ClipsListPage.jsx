import { useState, useEffect } from 'react'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import ClipCard from '../components/ClipCard'
import UploadButton from '../components/UploadButton'
import { ClipCardSkeleton } from '../components/Skeleton'

const PAGE_SIZE = 20

export default function ClipsListPage() {
  const api = useApi()
  const [clips, setClips] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  const [bulkSessionId, setBulkSessionId] = useState('')
  const [bulkLoading, setBulkLoading] = useState(false)

  async function load() {
    try {
      const [clipsData, sessionsData] = await Promise.all([
        api.get(`/clips?limit=${PAGE_SIZE}&offset=0`),
        api.get('/sessions?limit=100&offset=0'),
      ])
      setClips(clipsData)
      setSessions(Array.isArray(sessionsData) ? sessionsData : [])
      setOffset(PAGE_SIZE)
      setHasMore(clipsData.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load clips', err)
    } finally {
      setLoading(false)
    }
  }

  async function loadMore() {
    setLoadingMore(true)
    try {
      const more = await api.get(`/clips?limit=${PAGE_SIZE}&offset=${offset}`)
      setClips(prev => [...prev, ...more])
      setOffset(prev => prev + PAGE_SIZE)
      setHasMore(more.length === PAGE_SIZE)
    } catch (err) {
      console.error('Failed to load more clips', err)
    } finally {
      setLoadingMore(false)
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
    if (selectedClipIds.size === filtered.length) setSelectedClipIds(new Set())
    else setSelectedClipIds(new Set(filtered.map(c => c.id)))
  }

  async function handleBulkAssign() {
    if (!bulkSessionId || !selectedClipIds.size) return
    setBulkLoading(true)
    try {
      await Promise.all([...selectedClipIds].map(id => api.patch(`/clips/${id}`, { session_id: bulkSessionId })))
      setSelectedClipIds(new Set())
      setBulkSessionId('')
      await load()
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
      await load()
    } catch (err) {
      console.error('Bulk delete failed', err)
    } finally {
      setBulkLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const searchLower = search.toLowerCase()
  const filtered = searchLower
    ? clips.filter(c => c.filename.toLowerCase().includes(searchLower))
    : clips

  const unorganizedCount = clips.filter(c => !c.session_id).length

  return (
    <AppLayout active="clips">
      <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
        {/* Header */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Library</p>
            <h1 className="mt-1 font-display text-[32px] font-extrabold leading-none text-text">Clips</h1>
            {unorganizedCount > 0 && (
              <p className="mt-1 text-xs text-muted">{unorganizedCount} not yet in a session</p>
            )}
          </div>
          <UploadButton onUploadComplete={load} />
        </div>

        {/* Search */}
        {clips.length > 3 && (
          <div className="relative mb-6">
            <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search clips..."
              className="input pl-9"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">×</button>
            )}
          </div>
        )}

        {/* Select-all row */}
        {filtered.length > 1 && (
          <div className="mb-3 flex items-center gap-3">
            <button onClick={toggleSelectAll} className="text-xs text-muted transition-colors hover:text-text">
              {selectedClipIds.size === filtered.length ? 'Deselect all' : 'Select all'}
            </button>
            {selectedClipIds.size > 0 && <span className="text-xs text-muted">{selectedClipIds.size} selected</span>}
          </div>
        )}

        {/* Bulk action bar */}
        {selectedClipIds.size > 0 && (
          <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line2 bg-surface p-3">
            <select value={bulkSessionId} onChange={e => setBulkSessionId(e.target.value)} className="input flex-1">
              <option value="">Assign to session...</option>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>{s.label || `${s.session_type || 'Session'}`}</option>
              ))}
            </select>
            <Button size="sm" onClick={handleBulkAssign} disabled={!bulkSessionId || bulkLoading}>
              {bulkLoading ? 'Moving...' : 'Assign'}
            </Button>
            <Button variant="danger" size="sm" onClick={handleBulkDelete} disabled={bulkLoading}>
              Delete {selectedClipIds.size}
            </Button>
            <button onClick={() => setSelectedClipIds(new Set())} className="text-xs text-muted transition-colors hover:text-text">Cancel</button>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col gap-3">
            {[...Array(4)].map((_, i) => <ClipCardSkeleton key={i} />)}
          </div>
        ) : clips.length === 0 ? (
          <p className="text-sm text-muted">No clips yet. Upload your first clip to get started.</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted">No clips match "{search}".</p>
        ) : (
          <>
            <div className="flex flex-col gap-3">
              {filtered.map(clip => (
                <ClipCard
                  key={clip.id}
                  clip={clip}
                  onDelete={load}
                  onRetry={load}
                  selectable={filtered.length > 1}
                  selected={selectedClipIds.has(clip.id)}
                  onToggle={toggleClipSelect}
                />
              ))}
            </div>
            {hasMore && !searchLower && (
              <div className="mt-6 text-center">
                <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading...' : 'Load more clips'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </AppLayout>
  )
}
