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

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center gap-4 px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate('/dashboard')}
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
      </main>
    </div>
  )
}