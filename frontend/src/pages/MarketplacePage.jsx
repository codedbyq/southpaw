import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import StarRating from '../components/StarRating'

const SPECIALIZATION_LABELS = {
  boxing:     'Boxing',
  muay_thai:  'Muay Thai',
  mma:        'MMA',
  kickboxing: 'Kickboxing',
  wrestling:  'Wrestling',
  bjj:        'BJJ',
  judo:       'Judo',
  southpaw:   'Southpaw',
  clinch:     'Clinch work',
  footwork:   'Footwork',
}

function CoachCard({ coach }) {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate(`/coaches/${coach.id}`)}
      className="bg-gray-900 border border-gray-800 hover:border-gray-600 rounded-xl p-5 cursor-pointer transition-all"
    >
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className="w-14 h-14 rounded-full bg-gray-800 flex items-center justify-center flex-shrink-0 overflow-hidden text-2xl">
          {coach.avatar_url
            ? <img src={coach.avatar_url} alt={coach.display_name} className="w-full h-full object-cover" />
            : '🎯'
          }
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-semibold text-white truncate">
              {coach.display_name || 'Coach'}
            </h3>
            {coach.is_featured && (
              <span className="text-xs px-2 py-0.5 bg-yellow-900 text-yellow-400 rounded-full font-medium flex-shrink-0">
                Featured
              </span>
            )}
          </div>

          {coach.bio && (
            <p className="text-sm text-gray-400 line-clamp-2 mb-3">{coach.bio}</p>
          )}

          {/* Specializations */}
          {coach.specializations?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {coach.specializations.map(s => (
                <span
                  key={s}
                  className="text-xs px-2 py-0.5 bg-gray-800 text-gray-400 rounded-full"
                >
                  {SPECIALIZATION_LABELS[s] || s}
                </span>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="flex items-center gap-4 text-xs text-gray-500">
            {coach.rating && (
              <div className="flex items-center gap-1.5">
                <StarRating value={Math.round(coach.rating)} readonly size="sm" />
                <span>{coach.rating.toFixed(1)}</span>
              </div>
            )}
            {coach.review_count > 0 && (
              <span>{coach.review_count} review{coach.review_count !== 1 ? 's' : ''}</span>
            )}
            {coach.review_preference && coach.review_preference !== 'either' && (
              <span className="text-gray-600">
                Prefers {coach.review_preference} reviews
              </span>
            )}
            {coach.credit_rate && (
              <span className="ml-auto text-indigo-400 font-medium">
                {coach.credit_rate} credits / review
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function MarketplacePage() {
  const api = useApi()
  const navigate = useNavigate()
  const [coaches, setCoaches] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedSpec, setSelectedSpec] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const data = await api.get('/coaches')
        setCoaches(data)
      } catch (err) {
        console.error('Failed to load marketplace', err)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  const allSpecs = [...new Set(coaches.flatMap(c => c.specializations || []))]

  const filtered = selectedSpec
    ? coaches.filter(c => c.specializations?.includes(selectedSpec))
    : coaches

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate('/dashboard')}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          ← Dashboard
        </button>
        <span className="font-bold text-lg tracking-tight">Coach marketplace</span>
        <UserButton />
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-1">Find a coach</h1>
          <p className="text-gray-400 text-sm">
            Get expert feedback on your clips from world-class coaches.
          </p>
        </div>

        {loading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : coaches.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-500 text-sm">No coaches available yet.</p>
            <p className="text-gray-600 text-xs mt-1">Check back soon.</p>
          </div>
        ) : (
          <>
            {/* Specialization filter */}
            {allSpecs.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-6">
                <button
                  onClick={() => setSelectedSpec(null)}
                  className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                    selectedSpec === null
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:text-white'
                  }`}
                >
                  All
                </button>
                {allSpecs.map(s => (
                  <button
                    key={s}
                    onClick={() => setSelectedSpec(s === selectedSpec ? null : s)}
                    className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                      selectedSpec === s
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {SPECIALIZATION_LABELS[s] || s}
                  </button>
                ))}
              </div>
            )}

            {/* Coach list */}
            <div className="flex flex-col gap-4">
              {filtered.map(coach => (
                <CoachCard key={coach.id} coach={coach} />
              ))}
            </div>

            {filtered.length === 0 && (
              <p className="text-gray-500 text-sm text-center py-10">
                No coaches found for this specialization.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
