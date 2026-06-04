import { useState } from 'react'
import { useApi } from '../api/client'
import { useNavigate } from 'react-router-dom'

const STATUS_STYLES = {
  queued:     'bg-gray-800 text-gray-400',
  processing: 'bg-yellow-900 text-yellow-400',
  complete:   'bg-green-900 text-green-400',
  failed:     'bg-red-900 text-red-400',
  uploaded:   'bg-blue-900 text-blue-400',
  pending:    'bg-gray-800 text-gray-400',
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
      className={`flex items-center justify-between p-4 bg-gray-900 rounded-xl border transition-colors ${
        selected ? 'border-indigo-500 bg-indigo-950/20' : 'border-gray-800'
      }`}
      onClick={selectable ? () => onToggle?.(clip.id) : undefined}
      style={selectable ? { cursor: 'pointer' } : undefined}
    >
      <div className="flex items-center gap-4">
        {/* Checkbox */}
        {selectable && (
          <div
            className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center ${
              selected ? 'bg-indigo-500 border-indigo-500' : 'border-gray-600'
            }`}
          >
            {selected && <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12"><path d="M10 3L5 8.5 2 5.5l-1 1L5 10.5l6-7-1-0.5z"/></svg>}
          </div>
        )}
        {/* Thumbnail */}
        <div className="w-16 h-12 bg-gray-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
          {clip.thumbnail_url ? (
            <img
              src={clip.thumbnail_url}
              alt={clip.filename}
              className="w-full h-full object-cover"
            />
          ) : (
            <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
            </svg>
          )}
        </div>

        <div>
          <p className="font-medium text-sm text-white truncate max-w-xs">
            {clip.filename}
          </p>
          <p className="text-xs text-gray-500 mt-0.5">
            {new Date(clip.created_at).toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric'
            })}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
        {/* Status badge */}
        <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${STATUS_STYLES[jobStatus] || STATUS_STYLES.pending}`}>
          {STATUS_LABELS[jobStatus] || jobStatus}
        </span>

        {/* View button — only when processing is complete */}
        {isReady && (
          <button
            onClick={() => navigate(`/clips/${clip.id}`)}
            className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
          >
            View
          </button>
        )}

        {/* Delete button — hidden in select mode */}
        {!selectable && (
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
          >
            {deleting ? 'Deleting...' : 'Delete'}
          </button>
        )}
      </div>
    </div>
  )
}