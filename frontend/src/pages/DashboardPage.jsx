import { useState, useEffect } from 'react'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import UploadButton from '../components/UploadButton'
import ClipCard from '../components/ClipCard'

export default function DashboardPage() {
  const api = useApi()
  const [clips, setClips] = useState([])
  const [loading, setLoading] = useState(true)

  async function loadClips() {
    try {
      const data = await api.get('/clips')
      setClips(data)
    } catch (err) {
      console.error('Failed to load clips', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadClips()
  }, [])

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <UserButton />
      </nav>
      <main className="max-w-4xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-2xl font-semibold">Your clips</h2>
          <UploadButton onUploadComplete={loadClips} />
        </div>

        {loading && (
          <p className="text-gray-500 text-sm">Loading clips...</p>
        )}

        {!loading && clips.length === 0 && (
          <p className="text-gray-500 text-sm">
            No clips yet. Upload your first clip to get started.
          </p>
        )}

        {!loading && clips.length > 0 && (
          <div className="flex flex-col gap-4">
            {clips.map(clip => (
              <ClipCard key={clip.id} clip={clip} onDelete={loadClips} />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}