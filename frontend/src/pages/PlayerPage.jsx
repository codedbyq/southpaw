import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import CanvasPlayer from '../components/CanvasPlayer'

export default function PlayerPage() {
  const { clipId } = useParams()
  const navigate = useNavigate()
  const api = useApi()

  const [clip, setClip] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [feedback, setFeedback] = useState(null)
  const [feedbackLoading, setFeedbackLoading] = useState(false)
  const [feedbackError, setFeedbackError] = useState(null)

  useEffect(() => {
    async function loadClip() {
      try {
        const data = await api.get(`/clips/${clipId}`)
        setClip(data)
      } catch (err) {
        setError('Failed to load clip')
      } finally {
        setLoading(false)
      }
    }
    loadClip()
  }, [clipId])

  async function fetchFeedback() {
    setFeedbackLoading(true)
    setFeedbackError(null)
    try {
      const data = await api.get(`/clips/${clipId}/feedback`)
      setFeedback(data.feedback)
    } catch (err) {
      setFeedbackError(err.message || 'Failed to generate feedback')
    } finally {
      setFeedbackLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <p className="text-gray-400 text-sm">Loading...</p>
      </div>
    )
  }

  if (error || !clip) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <p className="text-red-400 text-sm">{error || 'Clip not found'}</p>
      </div>
    )
  }

  const isProcessed = clip.job?.status === 'complete'

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate(-1)}
          className="text-gray-400 hover:text-white transition-colors text-sm"
        >
          ← Back
        </button>
        <span className="font-medium text-sm text-gray-300 truncate">
          {clip.filename}
        </span>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <CanvasPlayer
          videoUrl={clip.video_url}
          resultUrl={clip.result_url}
        />

        {/* Coaching feedback — only shown when clip is processed */}
        {isProcessed && (
          <div className="mt-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Coaching feedback</h2>
              <button
                onClick={fetchFeedback}
                disabled={feedbackLoading}
                className="px-3 py-1.5 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg transition-colors"
              >
                {feedbackLoading ? 'Analysing...' : feedback ? 'Regenerate' : 'Get feedback'}
              </button>
            </div>

            {feedbackLoading && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
                <p className="text-sm text-gray-500 animate-pulse">
                  Analysing your clip data...
                </p>
              </div>
            )}

            {feedbackError && !feedbackLoading && (
              <p className="text-sm text-red-400">{feedbackError}</p>
            )}

            {feedback && !feedbackLoading && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 text-sm text-gray-300 leading-relaxed">
                {renderFeedback(feedback)}
              </div>
            )}

            {!feedback && !feedbackLoading && !feedbackError && (
              <p className="text-sm text-gray-600">
                Click "Get feedback" to generate AI coaching notes for this clip.
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}


function renderFeedback(text) {
  return text.split('\n').map((line, i) => {
    if (!line.trim()) return <div key={i} className="h-2" />

    const isBold = line.startsWith('**') && line.includes('**', 2)
    if (isBold) {
      const inner = line.replace(/^\*\*/, '').replace(/\*\*$/, '')
      return <p key={i} className="font-semibold text-white mt-3 first:mt-0">{inner}</p>
    }

    const parts = line.split(/\*\*(.*?)\*\*/g)
    return (
      <p key={i} className="text-gray-300">
        {parts.map((part, j) =>
          j % 2 === 1 ? <strong key={j} className="text-white">{part}</strong> : part
        )}
      </p>
    )
  })
}
