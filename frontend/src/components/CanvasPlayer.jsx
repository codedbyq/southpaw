import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react'
import {
  buildIndex,
  lookupFrame,
  drawFrame,
  findClosestSkeleton,
  SUBJECT_PALETTE
} from '../utils/skeletonRenderer'

// Electric Kiwi strike data-viz ramp — punches glow lime/green, kicks burn orange
const STRIKE_COLORS = {
  jab:             '#ccff00',
  cross:           '#dfff00',
  hook:            '#88ff00',
  roundhouse_kick: '#ff6b00',
  rear_kick:       '#ff9500',
}

// Show only the selected subject's strikes on the timeline (legacy clips have
// no subject_id → selectedSubject is null → show all).
function filterStrikes(all, subject) {
  if (subject == null) return all
  return all.filter(s => s.subject_id === subject)
}

// A subject earns a selector slot (and a skeleton color) with meaningful
// presence: ≥20% of frames or at least one strike. Fragmented background
// tracks stay muted gray on the canvas and out of the picker.
function filterSubjects(subjects, totalFrames) {
  return subjects.filter(s => (s.frames ?? 0) >= 0.2 * totalFrames || (s.strikes ?? 0) >= 1)
}

function CanvasPlayer({ videoUrl, resultUrl, comments = [], onTimeClick, selectedSubject = null, onSelectSubject, onSubjects, onQuality, hoveredSubject = null }, ref) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const keypointsRef = useRef(null)      // full frames array
  const timestampIndexRef = useRef(null) // sorted timestamps for binary search
  const activeSubjectRef = useRef(selectedSubject ?? 0) // which skeleton id to track
  const allStrikesRef = useRef([])       // every subject's strikes (with subject_id)
  const subjectColorsRef = useRef(null)  // {subject_id: palette color} for the rAF loop
  const hoverSubjectRef = useRef(null)   // chip-hover highlight without re-render
  const rafRef = useRef(null)            // rAF handle for cleanup
  const showLabelsRef = useRef(true)     // whether to show strike labels

  const [strikes, setStrikes] = useState([])
  const [strikeFilter, setStrikeFilter] = useState('all')
  const [showLabels, setShowLabels] = useState(true)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Load keypoint JSON on mount
  useEffect(() => {
    async function loadKeypoints() {
      try {
        const res = await fetch(resultUrl)
        const data = await res.json()
        keypointsRef.current = data.frames
        timestampIndexRef.current = buildIndex(data.frames)

        // Every subject's strikes (each tagged with subject_id)
        allStrikesRef.current = data.frames
          .filter(f => f.strikes && f.strikes.length > 0)
          .flatMap(f => f.strikes)

        // Report available subjects to the parent (for the selector):
        // presence-filtered, color-assigned in presence order so the chip
        // colors match the skeletons on the canvas.
        const rawSubjects = Array.isArray(data.subjects) && data.subjects.length
          ? data.subjects
          : [...new Set(data.frames.flatMap(f => (f.skeletons || []).map(s => s.id)))].map(id => ({ id }))
        const visible = filterSubjects(rawSubjects, data.frames.length)
        const colored = (visible.length ? visible : rawSubjects).map((s, i) => ({
          ...s,
          color: SUBJECT_PALETTE[i % SUBJECT_PALETTE.length],
        }))
        subjectColorsRef.current = Object.fromEntries(colored.map(s => [s.id, s.color]))
        if (onSubjects) onSubjects(colored)

        // Surface footage-quality components (written by the pipeline) so the
        // page can name the specific problem in its banner.
        if (onQuality && data.pose_quality) onQuality(data.pose_quality)

        setStrikes(filterStrikes(allStrikesRef.current, selectedSubject))
        setLoading(false)
      } catch (err) {
        setError('Failed to load pose data')
        setLoading(false)
      }
    }
    loadKeypoints()
  }, [resultUrl])

  // Re-filter the timeline + highlight when the selected subject changes
  useEffect(() => {
    activeSubjectRef.current = selectedSubject ?? 0
    if (!loading) setStrikes(filterStrikes(allStrikesRef.current, selectedSubject))
  }, [selectedSubject, loading])

  // Chip-hover highlight — synced to a ref so the rAF loop picks it up
  useEffect(() => {
    hoverSubjectRef.current = hoveredSubject
  }, [hoveredSubject])

  // Start rAF loop once keypoints are loaded and video is ready
  useEffect(() => {
    if (loading) return

    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return

    function syncCanvasSize() {
      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) return

      const videoAspect = video.videoWidth / video.videoHeight
      const containerWidth = video.clientWidth
      const containerHeight = video.clientHeight
      const containerAspect = containerWidth / containerHeight

      let renderWidth, renderHeight, offsetX, offsetY

      if (videoAspect < containerAspect) {
        // Video is narrower than container — black bars on left and right
        renderHeight = containerHeight
        renderWidth = containerHeight * videoAspect
        offsetX = (containerWidth - renderWidth) / 2
        offsetY = 0
      } else {
        // Video is wider than container — black bars on top and bottom
        renderWidth = containerWidth
        renderHeight = containerWidth / videoAspect
        offsetX = 0
        offsetY = (containerHeight - renderHeight) / 2
      }

      canvas.width = containerWidth
      canvas.height = containerHeight
      canvas._renderWidth = renderWidth
      canvas._renderHeight = renderHeight
      canvas._offsetX = offsetX
      canvas._offsetY = offsetY
    }

    function loop() {
      const time = video.currentTime
      setCurrentTime(time)

      if (keypointsRef.current && timestampIndexRef.current) {
        const idx = lookupFrame(timestampIndexRef.current, time)
        const frame = keypointsRef.current[idx]
        syncCanvasSize()
        drawFrame(canvas, frame, activeSubjectRef.current, showLabelsRef.current,
                  subjectColorsRef.current, hoverSubjectRef.current)
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    video.addEventListener('loadedmetadata', () => {
      setDuration(video.duration)
      syncCanvasSize()
    })

    rafRef.current = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(rafRef.current)
    }
  }, [loading])

  // Keep showLabelsRef in sync with state without restarting the loop
  useEffect(() => {
    showLabelsRef.current = showLabels
  }, [showLabels])

  function handleCanvasClick(e) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    if (!keypointsRef.current || !timestampIndexRef.current) return
    const idx = lookupFrame(timestampIndexRef.current, videoRef.current.currentTime)
    const frame = keypointsRef.current[idx]
    if (!frame) return

    // Pass canvas instead of width/height separately
    const subject = findClosestSkeleton(frame.skeletons, x, y, canvas)
    if (subject !== null) {
      activeSubjectRef.current = subject
      onSelectSubject?.(subject)
    }
  }

  function seekTo(timestamp) {
    if (videoRef.current) {
      videoRef.current.currentTime = timestamp
    }
  }

  // Let the parent (PlayerPage) seek the video / read the playhead
  useImperativeHandle(ref, () => ({
    seekTo,
    getCurrentTime: () => videoRef.current?.currentTime ?? 0,
    play: () => videoRef.current?.play(),
    pause: () => videoRef.current?.pause(),
    setPlaybackRate: (rate) => { if (videoRef.current) videoRef.current.playbackRate = rate },
  }), [])

  const filteredStrikes = strikeFilter === 'all'
    ? strikes
    : strikes.filter(s => s.type === strikeFilter)

  const strikeTypes = [...new Set(strikes.map(s => s.type))]

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-danger text-sm">{error}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-text3 text-sm animate-pulse">Loading pose data...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Video + Canvas stack — radial-vignette black stage */}
      <div className="relative w-full rounded-2xl overflow-hidden"
           style={{ aspectRatio: '16/9', background: 'radial-gradient(ellipse at 40% 35%, #1a1a1a 0%, #050505 70%)' }}>
        <video
          ref={videoRef}
          src={videoUrl}
          className="w-full h-full object-contain"
          controls
          playsInline
        />
        <canvas
          ref={canvasRef}
          onClick={handleCanvasClick}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: 'none', cursor: 'crosshair' }}
        />
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 text-sm text-text3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={e => setShowLabels(e.target.checked)}
            className="rounded accent-kiwi"
          />
          Show strike labels
        </label>

        {/* Strike type filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setStrikeFilter('all')}
            className={`chip ${strikeFilter === 'all' ? 'active' : ''}`}
          >
            All ({strikes.length})
          </button>
          {strikeTypes.map(type => (
            <button
              key={type}
              onClick={() => setStrikeFilter(type)}
              className="chip"
              style={strikeFilter === type
                ? { backgroundColor: STRIKE_COLORS[type], borderColor: STRIKE_COLORS[type], color: '#000' }
                : {}
              }
            >
              {type.replace('_', ' ')} ({strikes.filter(s => s.type === type).length})
            </button>
          ))}
        </div>
      </div>

      {/* Strike timeline */}
      {duration > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted uppercase tracking-wide font-semibold">
            Strike timeline — click to jump
          </p>
          <div className="relative w-full">
            {/* Comment markers above the bar — gold coach dots */}
            {comments.filter(c => c.timestamp_seconds != null).map(c => (
              <div
                key={c.id}
                className="absolute -top-2 w-2.5 h-2.5 rounded-full bg-gold cursor-pointer hover:scale-125 transition-transform shadow-[0_0_6px_rgba(255,215,0,0.6)] z-10"
                style={{ left: `calc(${(c.timestamp_seconds / duration) * 100}% - 5px)` }}
                onClick={() => seekTo(c.timestamp_seconds)}
                title={`${c.author_name}: ${c.body}`}
              />
            ))}

            <div
              className="relative w-full h-8 bg-surface3 rounded-lg overflow-hidden cursor-pointer"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect()
                const pct = (e.clientX - rect.left) / rect.width
                const t = pct * duration
                seekTo(t)
                if (onTimeClick) onTimeClick(t)
              }}
            >
              {/* Playhead — lime with glow */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-kiwi pointer-events-none shadow-[0_0_8px_rgba(204,255,0,0.8)]"
                style={{ left: `${(currentTime / duration) * 100}%` }}
              />

              {/* Strike markers */}
              {filteredStrikes.map((strike, i) => (
                <div
                  key={i}
                  className="absolute top-1 bottom-1 w-1 rounded-sm cursor-pointer hover:opacity-100 opacity-80 transition-opacity"
                  style={{
                    left: `${(strike.timestamp_seconds / duration) * 100}%`,
                    backgroundColor: STRIKE_COLORS[strike.type] || '#ffffff',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    seekTo(strike.timestamp_seconds)
                  }}
                  title={`${strike.type.replace('_', ' ')} at ${strike.timestamp_seconds.toFixed(1)}s`}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Strike count summary */}
      {strikes.length > 0 && (
        <div className="flex gap-4 flex-wrap">
          {strikeTypes.map(type => (
            <div key={type} className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: STRIKE_COLORS[type] }}
              />
              <span className="text-xs text-text3">
                <span className="font-display font-bold tabular-nums text-text">{strikes.filter(s => s.type === type).length}</span> {type.replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}

export default forwardRef(CanvasPlayer)