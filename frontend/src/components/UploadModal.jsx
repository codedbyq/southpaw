import { useState, useRef, useEffect } from 'react'
import { useAuth } from '@clerk/react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import Button from './Button'

const ACCEPTED_TYPES = ['video/mp4', 'video/quicktime', 'video/x-msvideo']
const CHUNK_SIZE = 10 * 1024 * 1024  // 10MB
const CONCURRENCY = 3
const MAX_PART_RETRIES = 3

const SPORTS = [
  { value: 'boxing',    emoji: '🥊', label: 'Boxing' },
  { value: 'muay_thai', emoji: '🦵', label: 'Muay Thai' },
  { value: 'mma',       emoji: '🤼', label: 'MMA' },
]

const SESSION_TYPES = [
  { value: 'sparring', label: 'Sparring' },
  { value: 'bag',      label: 'Bag work' },
  { value: 'pads',     label: 'Pads' },
  { value: 'shadow',   label: 'Shadow boxing' },
]

const TIPS = [
  'Film at eye level for the best skeleton tracking',
  'Good lighting = more accurate keypoint detection',
  'Keep the camera steady — tripod or against a wall',
  '2–4 minute clips give the richest session data',
]

const STEPS = ['File', 'Sport', 'Session', 'Notes']

function fmtSize(bytes) {
  if (bytes > 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

/**
 * Upload flow as a stepped modal wizard (File → Sport → Session → Notes →
 * Upload). Holds all the multipart-upload + SSE-progress + multi-file logic.
 */
export default function UploadModal({ onClose, onUploadComplete }) {
  const { getToken } = useAuth()
  const api = useApi()
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [state, setState] = useState('form')  // form | uploading | error
  const [step, setStep] = useState(0)
  const [files, setFiles] = useState([])
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState(null)

  const [fileStatuses, setFileStatuses] = useState([])
  const [singleProgress, setSingleProgress] = useState(0)
  const [singlePhase, setSinglePhase] = useState('uploading') // uploading | processing

  const [sport, setSport] = useState('boxing')
  const [sessions, setSessions] = useState([])
  const [sessionValue, setSessionValue] = useState('')   // '' | uuid | 'new'
  const [newLabel, setNewLabel] = useState('')
  const [newSessionType, setNewSessionType] = useState('sparring')
  const [clipNotes, setClipNotes] = useState('')
  const [autoNavigate, setAutoNavigate] = useState(true)

  const isMulti = files.length > 1

  useEffect(() => {
    api.get('/sessions').then(d => setSessions(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape' && state !== 'uploading') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, onClose])

  function acceptFiles(picked) {
    if (!picked.length) return
    const invalid = picked.find(f => !ACCEPTED_TYPES.includes(f.type))
    if (invalid) { setError('Unsupported file type. Please upload MP4 or MOV files.'); return }
    setFiles(picked)
    setError(null)
    setState('form')
  }

  function handleFileChange(e) { acceptFiles(Array.from(e.target.files || [])) }
  function handleDrop(e) {
    e.preventDefault(); setDragActive(false)
    acceptFiles(Array.from(e.dataTransfer.files || []))
  }

  function updateFileStatus(index, patch) {
    setFileStatuses(prev => prev.map((s, i) => i === index ? { ...s, ...patch } : s))
  }

  async function uploadFileMultipart(file, sessionId, fileIndex, onProgress) {
    const duration = await getVideoDuration(file).catch(() => null)
    const { clip_id, upload_id, s3_key, part_urls } = await api.post('/uploads/multipart/init', {
      filename: file.name, content_type: file.type, file_size: file.size,
      sport, session_id: sessionId, duration_seconds: duration, notes: clipNotes.trim() || null,
    })
    const parts = []
    let uploaded = 0
    async function uploadPart({ part_number, url }) {
      const etag = await uploadPartWithRetry(file, part_number, url)
      parts.push({ part_number, etag })
      uploaded++
      onProgress(Math.round((uploaded / part_urls.length) * 100))
    }
    for (let i = 0; i < part_urls.length; i += CONCURRENCY) {
      await Promise.all(part_urls.slice(i, i + CONCURRENCY).map(uploadPart))
    }
    parts.sort((a, b) => a.part_number - b.part_number)
    const { job_id } = await api.post('/uploads/multipart/complete', { clip_id, upload_id, s3_key, parts })
    return { clip_id, job_id }
  }

  async function handleSingleUpload(sessionId) {
    const file = files[0]
    setSinglePhase('uploading'); setSingleProgress(0)
    const { clip_id, job_id } = await uploadFileMultipart(file, sessionId, 0, p => setSingleProgress(Math.round(p * 0.9)))

    const token = await getToken()
    setSinglePhase('processing'); setSingleProgress(0)
    let succeeded = false
    await listenToJobProgress(job_id, token, (data) => {
      if (data.status === 'processing') setSingleProgress(data.progress)
      else if (data.status === 'complete') { succeeded = true; setSingleProgress(100) }
      else if (data.status === 'failed') { setError('Processing failed — please try again'); setState('error') }
    }, api.get)

    if (succeeded) {
      onUploadComplete?.()
      onClose()
      if (autoNavigate) navigate(sessionId ? `/sessions/${sessionId}` : `/clips/${clip_id}`)
    }
  }

  async function handleMultiUpload(sessionId) {
    setFileStatuses(files.map(f => ({ name: f.name, size: f.size, status: 'queued', progress: 0 })))
    let successCount = 0
    for (let i = 0; i < files.length; i++) {
      updateFileStatus(i, { status: 'uploading', progress: 0 })
      try {
        await uploadFileMultipart(files[i], sessionId, i, p => updateFileStatus(i, { progress: p }))
        updateFileStatus(i, { status: 'queued_processing', progress: 100 })
        successCount++
      } catch (err) {
        updateFileStatus(i, { status: 'failed', progress: 0 })
      }
    }
    if (successCount === 0) { setError('All uploads failed. Check your connection and try again.'); setState('error'); return }
    onUploadComplete?.()
    onClose()
    navigate(`/sessions/${sessionId}`)
  }

  async function handleStartUpload() {
    setState('uploading')
    try {
      let sessionId = sessionValue || null
      if (sessionValue === 'new') {
        const created = await api.post('/sessions', {
          label: newLabel || null, sport, session_type: newSessionType, notes: null,
        })
        sessionId = created.id
      }
      if (isMulti) await handleMultiUpload(sessionId)
      else await handleSingleUpload(sessionId)
    } catch (err) {
      console.error(err)
      setError(err.message)
      setState('error')
    }
  }

  const filteredSessions = sessions.filter(s => s.sport === sport)

  // Per-step gating
  const stepValid = [
    files.length > 0,                       // File
    true,                                   // Sport
    !isMulti || sessionValue !== '',        // Session
    true,                                   // Notes
  ]
  const isLastStep = step === STEPS.length - 1

  function next() { if (stepValid[step] && !isLastStep) setStep(s => s + 1) }
  function back() { setStep(s => Math.max(0, s - 1)) }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 sm:items-center sm:p-4" onClick={() => state !== 'uploading' && onClose()}>
      <div
        onClick={e => e.stopPropagation()}
        className="flex h-full w-full flex-col bg-surface sm:h-auto sm:max-h-[90vh] sm:max-w-xl sm:rounded-2xl sm:border sm:border-line"
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pb-4 pt-5">
          <div>
            <h2 className="font-display text-[26px] font-black leading-none tracking-tight text-text">Upload clip</h2>
            <p className="mt-1.5 text-xs text-text3">
              {state === 'uploading'
                ? 'Analysed with YOLOv8 · results in 2–3 minutes'
                : `Step ${step + 1} of ${STEPS.length} · ${STEPS[step]}`}
            </p>
          </div>
          {state !== 'uploading' && (
            <button onClick={onClose} className="text-2xl leading-none text-muted hover:text-text">×</button>
          )}
        </div>

        {/* Step progress */}
        {state === 'form' && (
          <div className="flex gap-1.5 px-6 pb-4">
            {STEPS.map((_, i) => (
              <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-surface3">
                <div className={`h-full rounded-full bg-kiwi transition-all duration-300 ${i <= step ? 'w-full' : 'w-0'}`} />
              </div>
            ))}
          </div>
        )}

        <input ref={fileInputRef} type="file" accept="video/mp4,video/quicktime,video/x-msvideo" multiple className="hidden" onChange={handleFileChange} />

        <div className="flex-1 overflow-y-auto px-6 pb-6">
          {/* ── Uploading: live queue ── */}
          {state === 'uploading' ? (
            <div className="space-y-3">
              <p className="font-display text-sm font-extrabold uppercase tracking-wider text-text3">
                {isMulti ? 'Upload queue' : (singlePhase === 'uploading' ? 'Uploading' : 'Analysing with YOLOv8')}
              </p>
              {isMulti ? (
                fileStatuses.map((fs, i) => <QueueItem key={i} fs={fs} />)
              ) : (
                <div className="rounded-2xl border border-line bg-surface2 p-4">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="truncate text-sm text-text">{files[0]?.name}</span>
                    <span className="font-display text-sm font-bold tabular-nums text-kiwi">{singleProgress}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-surface3">
                    <div className={`h-full rounded-full transition-all duration-300 ${singlePhase === 'uploading' ? 'bg-kiwi' : 'bg-warning'}`} style={{ width: `${singleProgress}%` }} />
                  </div>
                  <p className="mt-2 text-[11px] text-muted">
                    {singlePhase === 'uploading' ? 'Uploading to secure storage…' : 'YOLOv8 running · pose + strike detection'}
                  </p>
                </div>
              )}
            </div>
          ) : state === 'error' ? (
            <div className="space-y-3">
              <p className="text-sm text-danger">{error}</p>
              <Button variant="secondary" size="sm" onClick={() => { setState('form'); setError(null) }}>Back to upload</Button>
            </div>
          ) : (
            <>
              {/* ── Step 0: File ── */}
              {step === 0 && (
                files.length === 0 ? (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setDragActive(true) }}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={handleDrop}
                    className={`flex cursor-pointer flex-col items-center gap-3.5 rounded-[20px] border-2 border-dashed p-10 transition-all ${
                      dragActive ? 'border-kiwi bg-kiwi/5' : 'border-line2 hover:border-kiwi hover:bg-kiwi/[0.02]'
                    }`}
                  >
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line2 bg-surface2 text-3xl">🎬</div>
                    <p className="font-display text-[22px] font-extrabold text-text">Drop video here</p>
                    <p className="text-xs text-text3">MP4 or MOV · up to 500MB · 10 min max</p>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-muted">or</p>
                    <span className="btn btn-outline text-sm">Choose from library</span>
                  </div>
                ) : (
                  <div className="space-y-2 rounded-2xl border border-kiwi/30 bg-surface p-4">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg bg-surface2 text-xl">🎬</div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-text">{f.name}</p>
                          <p className="text-xs text-text3">{fmtSize(f.size)} · {f.type.split('/')[1]?.toUpperCase()}</p>
                        </div>
                        {i === 0 && <span className="text-sm font-bold text-kiwi">Ready</span>}
                      </div>
                    ))}
                    <button onClick={() => fileInputRef.current?.click()} className="text-xs text-muted hover:text-kiwi">Change selection</button>
                    {isMulti && <p className="text-[11px] text-kiwi">{files.length} clips · a session is required on the next steps.</p>}
                  </div>
                )
              )}

              {/* ── Step 1: Sport ── */}
              {step === 1 && (
                <div className="flex gap-2">
                  {SPORTS.map(s => (
                    <button key={s.value} onClick={() => { setSport(s.value); setSessionValue('') }}
                      className={`flex-1 rounded-xl border py-5 text-center transition-all ${
                        sport === s.value ? 'border-kiwi bg-kiwi/10 text-kiwi' : 'border-line2 bg-surface text-text3 hover:text-text'
                      }`}>
                      <div className="text-3xl leading-none">{s.emoji}</div>
                      <div className="mt-2 font-display text-base font-extrabold uppercase tracking-wide">{s.label}</div>
                    </button>
                  ))}
                </div>
              )}

              {/* ── Step 2: Session ── */}
              {step === 2 && (
                <div>
                  {isMulti && (
                    <p className="mb-3 rounded-lg border border-kiwi/40 bg-kiwi/8 px-3 py-2 text-xs text-kiwi">
                      A session is required when uploading multiple clips.
                    </p>
                  )}
                  <div className="overflow-hidden rounded-2xl border border-line">
                    {!isMulti && (
                      <SessionRow selected={sessionValue === ''} onClick={() => setSessionValue('')} name="No session — unorganized" muted />
                    )}
                    {filteredSessions.map(s => (
                      <SessionRow key={s.id} selected={sessionValue === s.id} onClick={() => setSessionValue(s.id)}
                        name={s.label || 'Untitled session'} meta={`${s.clip_count ?? 0} clip${s.clip_count === 1 ? '' : 's'} · ${SPORTS.find(x => x.value === s.sport)?.label || s.sport}`} />
                    ))}
                    <div className={`flex items-center gap-2 border-t border-line px-4 py-3 ${sessionValue === 'new' ? 'bg-kiwi/5' : ''}`}>
                      <button onClick={() => setSessionValue('new')}
                        className={`h-[18px] w-[18px] flex-shrink-0 rounded-full border-2 ${sessionValue === 'new' ? 'border-kiwi bg-kiwi' : 'border-line2'}`} />
                      <input value={newLabel} onChange={e => { setNewLabel(e.target.value); setSessionValue('new') }}
                        placeholder="+ Create new session..." className="flex-1 rounded-lg border border-line2 bg-surface2 px-3 py-2 text-[13px] text-text outline-none focus:border-kiwi" />
                      {sessionValue === 'new' && (
                        <select value={newSessionType} onChange={e => setNewSessionType(e.target.value)} className="rounded-lg border border-line2 bg-surface2 px-2 py-2 text-[13px] text-text outline-none focus:border-kiwi">
                          {SESSION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                        </select>
                      )}
                    </div>
                  </div>
                  {filteredSessions.length === 0 && !isMulti && (
                    <p className="mt-2 text-[11px] text-muted">No {SPORTS.find(x => x.value === sport)?.label} sessions yet — create one above or skip.</p>
                  )}
                </div>
              )}

              {/* ── Step 3: Notes ── */}
              {step === 3 && (
                <div className="space-y-5">
                  <div>
                    <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-muted">Notes for AI <span className="font-normal normal-case tracking-normal text-muted">(optional)</span></p>
                    <textarea value={clipNotes} onChange={e => setClipNotes(e.target.value)} rows={4}
                      placeholder="e.g. Focusing on keeping my guard up on the hook. I tend to drop my left hand when I throw the right cross..."
                      className="input resize-none" />
                    <p className="mt-1.5 text-[11px] text-muted">Specific context = better coaching feedback from the AI.</p>
                  </div>

                  {!isMulti && (
                    <label className="flex cursor-pointer select-none items-center gap-2">
                      <input type="checkbox" checked={autoNavigate} onChange={e => setAutoNavigate(e.target.checked)} className="h-3.5 w-3.5 accent-kiwi" />
                      <span className="text-xs text-text3">Open clip when processing completes</span>
                    </label>
                  )}

                  <div className="rounded-2xl border border-line bg-surface2 p-4">
                    <p className="mb-2.5 text-[11px] font-bold uppercase tracking-wider text-muted">Tips for better analysis</p>
                    {TIPS.map((t, i) => (
                      <div key={i} className="mb-1.5 flex items-start gap-2">
                        <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-kiwi" />
                        <span className="text-xs leading-relaxed text-text3">{t}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {state === 'form' && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-6 py-4">
            {step > 0 ? (
              <Button variant="ghost" onClick={back}>← Back</Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            )}
            {isLastStep ? (
              <Button className="rounded-xl px-6" onClick={handleStartUpload} disabled={!stepValid.every(Boolean)}>
                {isMulti ? `Upload ${files.length} clips →` : 'Upload & analyse →'}
              </Button>
            ) : (
              <Button className="rounded-xl px-6" onClick={next} disabled={!stepValid[step]}>Next →</Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionRow({ selected, onClick, name, meta, muted }) {
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left transition-colors last:border-0 hover:bg-surface2 ${selected ? 'bg-kiwi/5' : ''}`}>
      <span className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 ${selected ? 'border-kiwi bg-kiwi' : 'border-line2'}`}>
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-black" />}
      </span>
      <span className="min-w-0">
        <span className={`block truncate font-display text-base font-extrabold ${muted ? 'text-text3' : 'text-text'}`}>{name}</span>
        {meta && <span className="block text-xs text-text3">{meta}</span>}
      </span>
    </button>
  )
}

function QueueItem({ fs }) {
  const color = fs.status === 'failed' ? 'bg-danger' : fs.status === 'queued_processing' ? 'bg-kiwi' : fs.status === 'uploading' ? 'bg-kiwi' : 'bg-line2'
  const label = fs.status === 'queued' ? 'Queued' : fs.status === 'uploading' ? `${fs.progress}%` : fs.status === 'queued_processing' ? '✓ Done' : '✗ Failed'
  const labelColor = fs.status === 'failed' ? 'text-danger' : fs.status === 'queued_processing' ? 'text-kiwi' : fs.status === 'uploading' ? 'text-kiwi' : 'text-muted'
  return (
    <div className="rounded-2xl border border-line bg-surface2 p-3.5">
      <div className="mb-2 flex items-center gap-2.5">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-surface3 text-base">🎬</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-text">{fs.name}</p>
          <p className="text-[11px] text-text3">{fmtSize(fs.size)}</p>
        </div>
        <span className={`text-[11px] font-bold tabular-nums ${labelColor}`}>{label}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-surface3">
        <div className={`h-full rounded-full transition-all duration-300 ${color}`} style={{ width: `${fs.progress}%` }} />
      </div>
    </div>
  )
}

// ── upload helpers ──
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
      if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500 * attempt))
    }
  }
  throw new Error(`Part ${part_number} failed after ${maxRetries} attempts: ${lastErr.message}`)
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
      if (data.status === 'complete' || data.status === 'failed') { source.close(); resolve() }
    }
    source.onerror = () => { source.close(); pollJobUntilDone(jobId, onData, apiFetch).then(resolve, reject) }
  })
}

async function pollJobUntilDone(jobId, onData, apiFetch) {
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 3000))
    try {
      const data = await apiFetch(`/jobs/${jobId}`)
      onData(data)
      if (data.status === 'complete' || data.status === 'failed') return
    } catch {}
  }
  throw new Error('Processing timed out')
}
