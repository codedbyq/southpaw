import { useState, useRef } from 'react'
import { useAuth } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import Button from './Button'

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo']
const CHUNK_SIZE = 10 * 1024 * 1024  // 10MB
const CONCURRENCY = 3
const MAX_PART_RETRIES = 3

// Upload a single part with exponential backoff retries
async function uploadPartWithRetry(file, part_number, url, maxRetries = MAX_PART_RETRIES) {
  let lastErr
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const start = (part_number - 1) * CHUNK_SIZE
      const chunk = file.slice(start, start + CHUNK_SIZE)
      const res = await fetch(url, { method: 'PUT', body: chunk })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.headers.get('ETag')
    } catch (err) {
      lastErr = err
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * attempt)) // 0.5s, 1s, 1.5s
      }
    }
  }
  throw new Error(`Part ${part_number} failed after ${maxRetries} attempts: ${lastErr.message}`)
}

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

  // Core state
  const [state, setState] = useState('idle')  // idle | selecting | uploading | error
  const [files, setFiles] = useState([])       // File objects
  const [error, setError] = useState(null)

  // Per-file upload status (multi-file only)
  // [{ name, status: 'queued'|'uploading'|'queued_processing'|'failed', progress }]
  const [fileStatuses, setFileStatuses] = useState([])

  // Single-file SSE progress
  const [singleProgress, setSingleProgress] = useState(0)
  const [singlePhase, setSinglePhase] = useState('uploading') // uploading | processing

  // Shared upload options
  const [sport, setSport] = useState('boxing')
  const [sessions, setSessions] = useState([])
  const [sessionValue, setSessionValue] = useState('')   // '' | uuid | 'new'
  const [newLabel, setNewLabel] = useState('')
  const [newSessionType, setNewSessionType] = useState('sparring')
  const [newSessionNotes, setNewSessionNotes] = useState('')
  const [clipNotes, setClipNotes] = useState('')
  const [autoNavigate, setAutoNavigate] = useState(true)

  const isMulti = files.length > 1

  // ─── File selection ────────────────────────────────────────────────────────

  async function handleFileChange(e) {
    const picked = Array.from(e.target.files || [])
    if (!picked.length) return

    const invalid = picked.find(f => !ACCEPTED_TYPES.includes(f.type))
    if (invalid) {
      setError('Unsupported file type. Please upload MP4 or MOV files.')
      return
    }

    setFiles(picked)
    setError(null)
    setState('selecting')

    const sessionsData = await api.get('/sessions').catch(() => [])
    setSessions(Array.isArray(sessionsData) ? sessionsData : [])
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function updateFileStatus(index, patch) {
    setFileStatuses(prev => prev.map((s, i) => i === index ? { ...s, ...patch } : s))
  }

  async function uploadFileMultipart(file, sessionId, fileIndex) {
    updateFileStatus(fileIndex, { status: 'uploading', progress: 0 })

    const duration = await getVideoDuration(file).catch(() => null)

    const { clip_id, upload_id, s3_key, part_urls } = await api.post('/uploads/multipart/init', {
      filename: file.name,
      content_type: file.type,
      file_size: file.size,
      sport,
      session_id: sessionId,
      duration_seconds: duration,
      notes: clipNotes.trim() || null,
    })

    // Upload parts with per-chunk retry
    const parts = []
    let uploaded = 0

    async function uploadPart({ part_number, url }) {
      const etag = await uploadPartWithRetry(file, part_number, url)
      parts.push({ part_number, etag })
      uploaded++
      updateFileStatus(fileIndex, { progress: Math.round((uploaded / part_urls.length) * 100) })
    }

    for (let i = 0; i < part_urls.length; i += CONCURRENCY) {
      await Promise.all(part_urls.slice(i, i + CONCURRENCY).map(uploadPart))
    }

    parts.sort((a, b) => a.part_number - b.part_number)

    const { job_id } = await api.post('/uploads/multipart/complete', {
      clip_id, upload_id, s3_key, parts,
    })

    return { clip_id, job_id }
  }

  // ─── Single-file upload (with SSE progress + optional redirect to clip) ────

  async function handleSingleUpload(sessionId) {
    const file = files[0]
    setSinglePhase('uploading')
    setSingleProgress(0)

    const duration = await getVideoDuration(file).catch(() => null)

    const { clip_id, upload_id, s3_key, part_urls } = await api.post('/uploads/multipart/init', {
      filename: file.name,
      content_type: file.type,
      file_size: file.size,
      sport,
      session_id: sessionId,
      duration_seconds: duration,
      notes: clipNotes.trim() || null,
    })

    const parts = []
    let uploaded = 0

    async function uploadPart({ part_number, url }) {
      const etag = await uploadPartWithRetry(file, part_number, url)
      parts.push({ part_number, etag })
      uploaded++
      setSingleProgress(Math.round((uploaded / part_urls.length) * 90))
    }

    for (let i = 0; i < part_urls.length; i += CONCURRENCY) {
      await Promise.all(part_urls.slice(i, i + CONCURRENCY).map(uploadPart))
    }

    parts.sort((a, b) => a.part_number - b.part_number)

    const { job_id } = await api.post('/uploads/multipart/complete', {
      clip_id, upload_id, s3_key, parts,
    })

    const token = await getToken()
    setSinglePhase('processing')
    setSingleProgress(0)

    let succeeded = false
    await listenToJobProgress(job_id, token, (data) => {
      if (data.status === 'processing') setSingleProgress(data.progress)
      else if (data.status === 'complete') { succeeded = true; setSingleProgress(100) }
      else if (data.status === 'failed') { setError('Processing failed — please try again'); setState('error') }
    }, api.get)

    if (succeeded) {
      if (onUploadComplete) onUploadComplete()
      if (autoNavigate && sessionId) {
        navigate(`/sessions/${sessionId}`)
      } else if (autoNavigate) {
        navigate(`/clips/${clip_id}`)
      } else {
        setState('idle')
        setSingleProgress(0)
      }
    }
  }

  // ─── Multi-file upload (sequential, navigate to session when all queued) ───

  async function handleMultiUpload(sessionId) {
    const initial = files.map(f => ({ name: f.name, status: 'queued', progress: 0 }))
    setFileStatuses(initial)

    let successCount = 0
    for (let i = 0; i < files.length; i++) {
      try {
        await uploadFileMultipart(files[i], sessionId, i)
        updateFileStatus(i, { status: 'queued_processing', progress: 100 })
        successCount++
      } catch (err) {
        updateFileStatus(i, { status: 'failed', progress: 0, error: err.message })
        // Continue with remaining files — don't stop the batch
      }
    }

    if (successCount === 0) {
      setError('All uploads failed. Check your connection and try again.')
      setState('error')
      return
    }

    if (onUploadComplete) onUploadComplete()
    navigate(`/sessions/${sessionId}`)
  }

  // ─── Start upload ──────────────────────────────────────────────────────────

  async function handleStartUpload() {
    setState('uploading')

    try {
      // Resolve session
      let sessionId = sessionValue || null
      if (sessionValue === 'new') {
        const created = await api.post('/sessions', {
          label: newLabel || null,
          notes: newSessionNotes || null,
          sport,
          session_type: newSessionType,
        })
        sessionId = created.id
      }

      if (isMulti) {
        await handleMultiUpload(sessionId)
      } else {
        await handleSingleUpload(sessionId)
      }
    } catch (err) {
      console.error(err)
      setError(err.message)
      setState('error')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  function reset() {
    setState('idle')
    setError(null)
    setFiles([])
    setFileStatuses([])
    setSingleProgress(0)
    setSinglePhase('uploading')
    setSport('boxing')
    setSessionValue('')
    setNewLabel('')
    setNewSessionType('sparring')
    setNewSessionNotes('')
    setClipNotes('')
  }

  const filteredSessions = sessions.filter(s => s.sport === sport)
  const canStart = !isMulti
    ? true
    : sessionValue !== ''  // multi requires a session

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,video/x-msvideo"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Idle — show upload button */}
      {state === 'idle' && (
        <Button onClick={() => { reset(); fileInputRef.current?.click() }}>
          + Upload clip
        </Button>
      )}

      {/* Error — show message + retry / restart options */}
      {state === 'error' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-danger">{error}</p>
          <div className="flex gap-2">
            {files.length > 0 && (
              <Button size="sm" onClick={handleStartUpload}>Try again</Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => { reset(); fileInputRef.current?.click() }}>
              Choose different file
            </Button>
          </div>
        </div>
      )}

      {/* Selecting — file picker options */}
      {state === 'selecting' && (
        <div className="flex flex-col gap-3">
          {/* File list */}
          <div>
            {files.length === 1 ? (
              <p className="text-sm text-text3 truncate max-w-xs">{files[0].name}</p>
            ) : (
              <div className="space-y-1">
                <p className="text-xs text-muted">{files.length} clips selected</p>
                {files.map((f, i) => (
                  <p key={i} className="text-xs text-text3 truncate max-w-xs">• {f.name}</p>
                ))}
              </div>
            )}
          </div>

          {/* Multi-file session required notice */}
          {isMulti && (
            <p className="text-xs text-kiwi bg-kiwi/8 border border-kiwi/40 rounded-lg px-3 py-2">
              A session is required when uploading multiple clips.
            </p>
          )}

          {/* Sport + session */}
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">Sport</label>
              <select
                value={sport}
                onChange={e => { setSport(e.target.value); setSessionValue('') }}
                className="input w-auto"
              >
                {SPORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-muted">
                Session {isMulti ? <span className="text-danger">*</span> : '(optional)'}
              </label>
              <select
                value={sessionValue}
                onChange={e => setSessionValue(e.target.value)}
                className="input w-auto"
              >
                {!isMulti && <option value="">Skip</option>}
                {isMulti && <option value="">Select a session...</option>}
                {filteredSessions.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.label || `${s.session_type || 'session'}`}
                  </option>
                ))}
                <option value="new">+ Create new session</option>
              </select>
            </div>
          </div>

          {/* Inline session create */}
          {sessionValue === 'new' && (
            <div className="flex flex-wrap gap-3 pl-3 border-l-2 border-kiwi">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted">Label (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Saturday sparring"
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  className="input w-48"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted">Type</label>
                <select
                  value={newSessionType}
                  onChange={e => setNewSessionType(e.target.value)}
                  className="input w-auto"
                >
                  {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1 w-full">
                <label className="text-xs text-muted">Session notes (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Focusing on combinations and footwork"
                  value={newSessionNotes}
                  onChange={e => setNewSessionNotes(e.target.value)}
                  className="input"
                />
              </div>
            </div>
          )}

          {/* Clip notes */}
          <div>
            <label className="text-xs text-muted mb-1 block">
              {isMulti ? 'Notes for all clips' : 'What are you working on?'}{' '}
              <span className="text-muted">
                {isMulti
                  ? '(optional — applies to all clips; edit per-clip notes from the player page after upload)'
                  : '(optional — helps the AI focus feedback)'}
              </span>
            </label>
            <textarea
              value={clipNotes}
              onChange={e => setClipNotes(e.target.value)}
              placeholder="e.g. Drilling hooks, working on guard after the jab..."
              rows={2}
              className="input resize-none"
            />
          </div>

          {/* Auto-navigate (single only) */}
          {!isMulti && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoNavigate}
                onChange={e => setAutoNavigate(e.target.checked)}
                className="w-3.5 h-3.5 accent-kiwi"
              />
              <span className="text-xs text-text3">Open clip when processing completes</span>
            </label>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <Button size="sm" onClick={handleStartUpload} disabled={!canStart}>
              {isMulti ? `Upload ${files.length} clips` : 'Start upload'}
            </Button>
            <Button variant="secondary" size="sm" onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Uploading — single file */}
      {state === 'uploading' && !isMulti && (
        <div className="flex items-center gap-3">
          <div className="w-40 h-2 bg-surface3 rounded-full overflow-hidden">
            <div
              className={`h-full transition-all duration-200 ${singlePhase === 'uploading' ? 'bg-kiwi' : 'bg-warning'}`}
              style={{ width: `${singleProgress}%` }}
            />
          </div>
          <span className="text-sm text-text3 tabular-nums">
            {singlePhase === 'uploading' ? `Uploading ${singleProgress}%` : `Analysing ${singleProgress}%`}
          </span>
        </div>
      )}

      {/* Uploading — multi file */}
      {state === 'uploading' && isMulti && (
        <div className="flex flex-col gap-2 min-w-[240px]">
          {fileStatuses.map((fs, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-text3 truncate">{fs.name}</p>
                <div className="w-full h-1.5 bg-surface3 rounded-full overflow-hidden mt-1">
                  <div
                    className={`h-full rounded-full transition-all duration-200 ${
                      fs.status === 'failed' ? 'bg-danger' :
                      fs.status === 'queued_processing' ? 'bg-kiwi' :
                      fs.status === 'uploading' ? 'bg-kiwi' : 'bg-line2'
                    }`}
                    style={{ width: `${fs.progress}%` }}
                  />
                </div>
              </div>
              <span className={`text-xs flex-shrink-0 w-16 text-right tabular-nums ${fs.status === 'failed' ? 'text-danger' : 'text-muted'}`}>
                {fs.status === 'queued' ? 'Queued' :
                 fs.status === 'uploading' ? `${fs.progress}%` :
                 fs.status === 'queued_processing' ? '✓ Done' : '✗ Failed'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Inline error for uploading state (e.g. SSE processing failure) */}
      {state !== 'error' && error && (
        <p className="mt-2 text-sm text-danger">{error}</p>
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


function listenToJobProgress(jobId, token, onData, apiFetch) {
  return new Promise((resolve, reject) => {
    const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
    const source = new EventSource(`${API_URL}/jobs/${jobId}/stream?token=${token}`)
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
      pollJobUntilDone(jobId, onData, apiFetch).then(resolve, reject)
    }
  })
}

async function pollJobUntilDone(jobId, onData, apiFetch) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const data = await apiFetch(`/jobs/${jobId}`)
      onData(data)
      if (data.status === 'complete' || data.status === 'failed') return
    } catch {
      // Network blip — keep polling
    }
  }
  throw new Error('Processing timed out')
}
