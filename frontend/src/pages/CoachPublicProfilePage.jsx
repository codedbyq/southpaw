import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import RequestReviewModal from '../components/RequestReviewModal'
import StarRating from '../components/StarRating'
import { CoachCardSkeleton } from '../components/Skeleton'

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

export default function CoachPublicProfilePage() {
  const { coachId } = useParams()
  const navigate = useNavigate()
  const api = useApi()
  const [coach, setCoach] = useState(null)
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showReviewModal, setShowReviewModal] = useState(false)
  const [reviewSent, setReviewSent] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const [data, userData] = await Promise.all([
          api.get(`/coaches/${coachId}`),
          api.get('/users/me'),
        ])
        setCoach(data)
        setCurrentUser(userData)
      } catch (err) {
        if (err.message === 'Coach not found') setNotFound(true)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [coachId])

  if (loading) return (
    <div className="min-h-screen bg-gray-950">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="w-20 h-4 bg-gray-800 animate-pulse rounded" />
        <div className="w-32 h-4 bg-gray-800 animate-pulse rounded" />
        <div className="w-8 h-8 bg-gray-800 animate-pulse rounded-full" />
      </nav>
      <main className="max-w-2xl mx-auto px-6 py-10 space-y-6">
        <CoachCardSkeleton />
        <div className="bg-gray-800 animate-pulse rounded-xl w-full h-48" />
        <div className="space-y-2">
          <div className="w-24 h-4 bg-gray-800 animate-pulse rounded" />
          <div className="w-full h-20 bg-gray-800 animate-pulse rounded" />
        </div>
      </main>
    </div>
  )

  if (notFound) return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-white font-medium mb-2">Coach not found</p>
        <button onClick={() => navigate('/coaches')} className="text-sm text-indigo-400 hover:text-indigo-300">
          ← Back to marketplace
        </button>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate('/coaches')}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          ← Marketplace
        </button>
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <UserButton />
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-10">

        {/* Header */}
        <div className="flex items-start gap-6 mb-8">
          <div className="w-20 h-20 rounded-full bg-gray-800 flex items-center justify-center flex-shrink-0 overflow-hidden text-3xl">
            {coach.avatar_url
              ? <img src={coach.avatar_url} alt={coach.display_name} className="w-full h-full object-cover" />
              : '🎯'
            }
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-1">
              <h1 className="text-2xl font-bold">{coach.display_name || 'Coach'}</h1>
              {coach.is_featured && (
                <span className="text-xs px-2 py-0.5 bg-yellow-900 text-yellow-400 rounded-full font-medium">
                  Featured
                </span>
              )}
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-4 text-sm text-gray-400 mb-3">
              {coach.rating && (
              <div className="flex items-center gap-1.5">
                <StarRating value={Math.round(coach.rating)} readonly size="sm" />
                <span>{coach.rating.toFixed(1)}</span>
              </div>
            )}
              {coach.review_count > 0 && (
                <span>{coach.review_count} review{coach.review_count !== 1 ? 's' : ''}</span>
              )}
              {coach.avg_response_hours && (
                <span className="text-gray-500 text-xs">
                  ~{coach.avg_response_hours < 24
                    ? `${Math.round(coach.avg_response_hours)}h`
                    : `${Math.round(coach.avg_response_hours / 24)}d`} avg response
                </span>
              )}
              {coach.review_preference && coach.review_preference !== 'either' && (
                <span className="text-gray-500 text-xs">
                  Prefers {coach.review_preference} reviews
                </span>
              )}
              {coach.credit_rate && (
                <span className="text-indigo-400 font-medium">
                  {coach.credit_rate} credits / review
                </span>
              )}
            </div>

            {/* Specializations */}
            {coach.specializations?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {coach.specializations.map(s => (
                  <span key={s} className="text-xs px-2.5 py-1 bg-gray-800 text-gray-400 rounded-full">
                    {SPECIALIZATION_LABELS[s] || s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Intro video */}
        {coach.intro_video_url && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-gray-400 mb-3">Intro</h2>
            <video
              src={coach.intro_video_url}
              controls
              poster={coach.intro_video_thumb_url || undefined}
              className="w-full rounded-xl bg-gray-900 max-h-72 object-cover"
            />
          </div>
        )}

        {/* Bio */}
        {coach.bio && (
          <div className="mb-8">
            <h2 className="text-sm font-medium text-gray-400 mb-3">About</h2>
            <p className="text-gray-300 text-sm leading-relaxed whitespace-pre-wrap">{coach.bio}</p>
          </div>
        )}

        {/* Request review CTA */}
        <div className="p-5 bg-gray-900 border border-gray-800 rounded-xl">
          {reviewSent ? (
            <div className="text-center py-2">
              <p className="text-green-400 font-medium text-sm">✓ Review request sent</p>
              <p className="text-gray-500 text-xs mt-1">
                {coach.display_name || 'The coach'} will be notified and will leave feedback on your clip.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-white">Get feedback from {coach.display_name || 'this coach'}</p>
                <p className="text-sm text-gray-400 mt-0.5">
                  {coach.credit_rate
                    ? `${coach.credit_rate} credits per clip review`
                    : 'Credit rate not set'}
                </p>
              </div>
              <button
                onClick={() => setShowReviewModal(true)}
                disabled={!coach.credit_rate}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
              >
                Request review
              </button>
            </div>
          )}
        </div>

        {showReviewModal && (
          <RequestReviewModal
            coach={coach}
            currentUser={currentUser}
            onClose={() => setShowReviewModal(false)}
            onSuccess={() => {
              setShowReviewModal(false)
              setReviewSent(true)
            }}
          />
        )}

      </main>
    </div>
  )
}
