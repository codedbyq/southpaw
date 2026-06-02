import { useState, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo']

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

export default function UploadButton({ onUploadComplete }) {
  const { getToken } = useAuth()
  const api = useApi()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [state, setState] = useState('idle')  // idle | selecting | uploading | processing | error
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState(null)
  const [file, setFile] = useState(null)

  const [sport, setSport] = useState('boxing')
  const [sessions, setSessions] = useState([])
  const [sessionValue, setSessionValue] = useState('')   // '' = skip, uuid = existing, 'new' = create inline
  const [newLabel, setNewLabel] = useState('')
  const [newSessionType, setNewSessionType] = useState('sparring')
  const [durationSeconds, setDurationSeconds] = useState(null)

  async function handleFileChange(e) {
    const picked = e.target.files?.[0]
    if (!picked) return

    if (!ACCEPTED_TYPES.includes(picked.type)) {
      setError('Unsupported file type. Please upload an MP4 or MOV file.')
      return
    }

    setFile(picked)
    setError(null)
    setState('selecting')

    // Extract duration and fetch sessions in parallel — both non-fatal if they fail
    const [duration, sessionsData] = await Promise.allSettled([
      getVideoDuration(picked),
      api.get('/sessions'),
    ])

    setDurationSeconds(duration.status === 'fulfilled' ? duration.value : null)
    setSessions(sessionsData.status === 'fulfilled' ? sessionsData.value : [])
  }

  async function handleStartUpload() {
    setState('uploading')
    setProgress(0)

    try {
      // Create new session inline if requested
      let session_id = sessionValue || null
      if (sessionValue === 'new') {
        const created = await api.post('/sessions', {
          label: newLabel || null,
          sport,
          session_type: newSessionType,
        })
        session_id = created.id
      }

      const { clip_id, upload_url } = await api.post('/uploads/init', {
        filename: file.name,
        content_type: file.type,
        sport,
        session_id,
        duration_seconds: durationSeconds,
      })

      await uploadToS3(file, upload_url, (pct) => setProgress(pct))

      const { job_id } = await api.post('/uploads/complete', { clip_id })

      const token = await getToken()
      setState('processing')
      setProgress(0)

      let succeeded = false
      await listenToJobProgress(job_id, token, (data) => {
        if (data.status === 'processing') {
          setProgress(data.progress)
        } else if (data.status === 'complete') {
          succeeded = true
          setProgress(100)
        } else if (data.status === 'failed') {
          setError('Processing failed — please try again')
          setState('error')
        }
      })

      if (succeeded) {
        if (onUploadComplete) onUploadComplete()
        navigate(`/clips/${clip_id}`)
      }

    } catch (err) {
      console.error(err)
      setError(err.message)
      setState('error')
    } finally {
      fileInputRef.current.value = ''
    }
  }

  function reset() {
    setState('idle')
    setError(null)
    setFile(null)
    setSport('boxing')
    setSessionValue('')
    setNewLabel('')
    setNewSessionType('sparring')
    setDurationSeconds(null)
  }

  // Only show sessions matching the selected sport
  const filteredSessions = sessions.filter(s => s.sport === sport)

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/x-msvideo"
        className="hidden"
        onChange={handleFileChange}
      />

      {(state === 'idle' || state === 'error') && (
        <button
          onClick={() => {
            reset()
            fileInputRef.current?.click()
          }}
          className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-500 transition-colors"
        >
          Upload clip
        </button>
      )}

      {state === 'selecting' && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-gray-400 truncate max-w-xs">{file.name}</p>

          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Sport</label>
              <select
                value={sport}
                onChange={e => { setSport(e.target.value); setSessionValue('') }}
                className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg"
              >
                {SPORTS.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">Session (optional)</label>
              <select
                value={sessionValue}
                onChange={e => setSessionValue(e.target.value)}
                className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg"
              >
                <option value="">Skip</option>
                {filteredSessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.label || `${s.session_type || 'session'}`}
                  </option>
                ))}
                <option value="new">+ Create new session</option>
              </select>
            </div>
          </div>

          {sessionValue === 'new' && (
            <div className="flex flex-wrap gap-3 pl-3 border-l-2 border-indigo-800">
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
                <label className="text-xs text-gray-500">Type</label>
                <select
                  value={newSessionType}
                  onChange={e => setNewSessionType(e.target.value)}
                  className="px-3 py-1.5 bg-gray-800 border border-gray-700 text-white text-sm rounded-lg"
                >
                  {SESSION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleStartUpload}
              className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-500 transition-colors text-sm"
            >
              Start upload
            </button>
            <button
              onClick={reset}
              className="px-3 py-2 bg-gray-700 text-gray-300 font-medium rounded-lg hover:bg-gray-600 transition-colors text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {state === 'uploading' && (
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-indigo-500 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-gray-400">Uploading {progress}%</span>
        </div>
      )}

      {state === 'processing' && (
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-gray-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all duration-200"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-sm text-gray-400">Analysing {progress}%</span>
        </div>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
    </div>
  )
}


function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src)
      resolve(isFinite(video.duration) ? Math.round(video.duration) : null)
    }
    video.onerror = () => reject(new Error('Could not read video duration'))
    video.src = URL.createObjectURL(file)
  })
}


function uploadToS3(file, presignedUrl, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        onProgress(Math.round((e.loaded / e.total) * 100))
      }
    })

    xhr.addEventListener('load', () => {
      if (xhr.status === 200) resolve()
      else reject(new Error(`S3 upload failed with status ${xhr.status}`))
    })

    xhr.addEventListener('error', () => reject(new Error('S3 upload failed')))

    xhr.open('PUT', presignedUrl)
    xhr.setRequestHeader('Content-Type', file.type)
    xhr.send(file)
  })
}


function listenToJobProgress(jobId, token, onData) {
  return new Promise((resolve, reject) => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    const source = new EventSource(
      `${API_URL}/jobs/${jobId}/stream?token=${token}`
    )

    source.onmessage = (event) => {
      const data = JSON.parse(event.data)
      onData(data)
      if (data.status === 'complete' || data.status === 'failed') {
        source.close()
        resolve()
      }
    }

    source.onerror = () => {
      source.close()
      reject(new Error('SSE connection lost'))
    }
  })
}
