import { useEffect, useRef, useState } from 'react'
import {
  buildIndex,
  lookupFrame,
  drawFrame,
  findClosestSkeleton
} from '../utils/skeletonRenderer'

const STRIKE_COLORS = {
  jab:             '#818cf8',
  cross:           '#a78bfa',
  hook:            '#f472b6',
  roundhouse_kick: '#fb923c',
  rear_kick:       '#facc15',
}

export default function CanvasPlayer({ videoUrl, resultUrl }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const keypointsRef = useRef(null)      // full frames array
  const timestampIndexRef = useRef(null) // sorted timestamps for binary search
  const activeSubjectRef = useRef(0)     // which skeleton to track
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

        // Extract all strikes for the timeline
        const allStrikes = data.frames
          .filter(f => f.strikes && f.strikes.length > 0)
          .flatMap(f => f.strikes)
        setStrikes(allStrikes)
        setLoading(false)
      } catch (err) {
        setError('Failed to load pose data')
        setLoading(false)
      }
    }
    loadKeypoints()
  }, [resultUrl])

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
        drawFrame(canvas, frame, activeSubjectRef.current, showLabelsRef.current)
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
    }
  }

  function seekTo(timestamp) {
    if (videoRef.current) {
      videoRef.current.currentTime = timestamp
    }
  }

  const filteredStrikes = strikeFilter === 'all'
    ? strikes
    : strikes.filter(s => s.type === strikeFilter)

  const strikeTypes = [...new Set(strikes.map(s => s.type))]

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-red-400 text-sm">{error}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-gray-400 text-sm">Loading pose data...</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Video + Canvas stack */}
      <div className="relative w-full bg-black rounded-xl overflow-hidden"
           style={{ aspectRatio: '16/9' }}>
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
        <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showLabels}
            onChange={e => setShowLabels(e.target.checked)}
            className="rounded"
          />
          Show strike labels
        </label>

        {/* Strike type filter */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setStrikeFilter('all')}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              strikeFilter === 'all'
                ? 'bg-white text-gray-950 border-white'
                : 'border-gray-700 text-gray-400 hover:border-gray-500'
            }`}
          >
            All ({strikes.length})
          </button>
          {strikeTypes.map(type => (
            <button
              key={type}
              onClick={() => setStrikeFilter(type)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                strikeFilter === type
                  ? 'border-transparent text-white'
                  : 'border-gray-700 text-gray-400 hover:border-gray-500'
              }`}
              style={strikeFilter === type
                ? { backgroundColor: STRIKE_COLORS[type], borderColor: STRIKE_COLORS[type] }
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
          <p className="text-xs text-gray-500 uppercase tracking-wide">
            Strike timeline — click to jump
          </p>
          <div
            className="relative w-full h-8 bg-gray-900 rounded-lg overflow-hidden cursor-pointer"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              seekTo(pct * duration)
            }}
          >
            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white opacity-60 pointer-events-none"
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
              <span className="text-xs text-gray-400">
                {strikes.filter(s => s.type === type).length} {type.replace('_', ' ')}
              </span>
            </div>
          ))}
        </div>
      )}

    </div>
  )
}