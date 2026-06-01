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

export default function ClipCard({ clip, onDelete }) {
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
    <div className="flex items-center justify-between p-4 bg-gray-900 rounded-xl border border-gray-800">
      <div className="flex items-center gap-4">
        {/* Thumbnail placeholder */}
        <div className="w-16 h-12 bg-gray-800 rounded-lg flex items-center justify-center flex-shrink-0">
          <svg className="w-6 h-6 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M15.75 10.5l4.72-4.72a.75.75 0 011.28.53v11.38a.75.75 0 01-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 002.25-2.25v-9a2.25 2.25 0 00-2.25-2.25h-9A2.25 2.25 0 002.25 7.5v9a2.25 2.25 0 002.25 2.25z" />
          </svg>
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

      <div className="flex items-center gap-3">
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

        {/* Delete button */}
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-xs px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-white rounded-lg transition-colors disabled:opacity-50"
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </div>
  )
}