import { useState } from 'react'
import { useApi } from '../api/client'
import { useNavigate } from 'react-router-dom'
import Button from './Button'
import Tag from './Tag'

const STATUS_TONES = {
  queued:     'muted',
  processing: 'warning',
  complete:   'success',
  failed:     'danger',
  uploaded:   'pads',
  pending:    'muted',
}

const STATUS_LABELS = {
  queued:     'Queued',
  processing: 'Processing',
  complete:   'Ready',
  failed:     'Failed',
  uploaded:   'Uploaded',
  pending:    'Pending',
}

export default function ClipCard({ clip, onDelete, selectable = false, selected = false, onToggle }) {
  const api = useApi()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)

  const jobStatus = clip.job?.status || clip.status
  const isReady = clip.job?.status === 'complete'

  async function handleDelete() {
    if (!confirm(`Delete "${clip.filename}"?`)) return
    setDeleting(true)
    try {
      await api.delete(`/clips/${clip.id}`)
      onDelete()
    } catch (err) {
      console.error('Delete failed', err)
      setDeleting(false)
    }
  }

  return (
    <div
      className={`flex items-center justify-between rounded-2xl border bg-surface p-4 transition-colors ${
        selected ? 'border-kiwi bg-kiwi/8' : 'border-line hover:border-line2'
      }`}
      onClick={selectable ? () => onToggle?.(clip.id) : undefined}
      style={selectable ? { cursor: 'pointer' } : undefined}
    >
      <div className="flex items-center gap-4">
        {/* Checkbox */}
        {selectable && (
          <div
            className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border ${
              selected ? 'border-kiwi bg-kiwi' : 'border-line2'
            }`}
          >
            {selected && <svg className="h-2.5 w-2.5 text-black" fill="currentColor" viewBox="0 0 12 12"><path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7-1-0.5z"/></svg>}
          </div>
        )}
        {/* Thumbnail */}
        <div className="flex h-12 w-16 flex-shrink-0 items-center justify-center overflow-hidden rounded-lg bg-surface3">
          {clip.thumbnail_url ? (
            <img
              src={clip.thumbnail_url}
              alt={clip.filename}
              className="h-full w-full object-cover"
            />
          ) : (
            <svg className="h-6 w-6 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          )}
        </div>

        <div>
          <p className="max-w-xs truncate text-sm font-medium text-text">
            {clip.filename}
          </p>
          <p className="mt-0.5 text-xs text-muted">
            {new Date(clip.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric'
            })}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
        {/* Status badge */}
        <Tag tone={STATUS_TONES[jobStatus] || 'muted'}>
          {STATUS_LABELS[jobStatus] || jobStatus}
        </Tag>

        {/* View button — only when processing is complete */}
        {isReady && (
          <Button size="sm" onClick={() => navigate(`/clips/${clip.id}`)}>View</Button>
        )}

        {/* Delete button — hidden in select mode */}
        {!selectable && (
          <Button variant="secondary" size="sm" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        )}
      </div>
    </div>
  )
}
