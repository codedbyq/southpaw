import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
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
    <AppLayout active="marketplace">
      <main className="mx-auto max-w-2xl space-y-6 px-8 py-10">
        <CoachCardSkeleton />
        <div className="h-48 w-full animate-pulse rounded-2xl bg-surface2" />
        <div className="space-y-2">
          <div className="h-4 w-24 animate-pulse rounded bg-surface2" />
          <div className="h-20 w-full animate-pulse rounded bg-surface2" />
        </div>
      </main>
    </AppLayout>
  )

  if (notFound) return (
    <AppLayout active="marketplace">
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <p className="mb-2 font-medium text-text">Coach not found</p>
          <button onClick={() => navigate('/coaches')} className="text-sm text-kiwi hover:text-kiwi-bright">
            ← Back to marketplace
          </button>
        </div>
      </div>
    </AppLayout>
  )

  return (
    <AppLayout active="marketplace">
      <main className="mx-auto max-w-2xl px-8 py-10">
        <button
          onClick={() => navigate('/coaches')}
          className="mb-6 text-sm text-muted transition-colors hover:text-text"
        >
          ← Marketplace
        </button>

        {/* Header */}
        <div className="mb-8 flex items-start gap-6">
          <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-kiwi bg-surface3 text-3xl">
            {coach.avatar_url
              ? <img src={coach.avatar_url} alt={coach.display_name} className="h-full w-full object-cover" />
              : '🎯'
            }
          </div>
          <div className="flex-1">
            <div className="mb-1.5 flex items-center gap-3">
              <h1 className="font-display text-[28px] font-extrabold tracking-tight text-text">{coach.display_name || 'Coach'}</h1>
              {coach.is_featured && <Tag tone="success">Featured</Tag>}
            </div>

            {/* Stats row */}
            <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-text3">
              {coach.rating && (
                <div className="flex items-center gap-1.5">
                  <StarRating value={Math.round(coach.rating)} readonly size="sm" />
                  <span className="tabular-nums">{coach.rating.toFixed(1)}</span>
                </div>
              )}
              {coach.review_count > 0 && (
                <span>{coach.review_count} review{coach.review_count !== 1 ? 's' : ''}</span>
              )}
              {coach.avg_response_hours && (
                <span className="text-xs text-muted">
                  ~{coach.avg_response_hours < 24
                    ? `${Math.round(coach.avg_response_hours)}h`
                    : `${Math.round(coach.avg_response_hours / 24)}d`} avg response
                </span>
              )}
              {coach.review_preference && coach.review_preference !== 'either' && (
                <span className="text-xs text-muted">
                  Prefers {coach.review_preference} reviews
                </span>
              )}
              {coach.credit_rate && (
                <span className="font-display font-bold text-kiwi">
                  {coach.credit_rate} credits / review
                </span>
              )}
            </div>

            {/* Specializations */}
            {coach.specializations?.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {coach.specializations.map(s => (
                  <Tag key={s} tone="spar">{SPECIALIZATION_LABELS[s] || s}</Tag>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Intro video */}
        {coach.intro_video_url && (
          <div className="mb-8">
            <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-muted">Intro</h2>
            <video
              src={coach.intro_video_url}
              controls
              poster={coach.intro_video_thumb_url || undefined}
              className="max-h-72 w-full rounded-2xl bg-surface object-cover"
            />
          </div>
        )}

        {/* Bio */}
        {coach.bio && (
          <div className="mb-8">
            <h2 className="mb-3 font-display text-sm font-bold uppercase tracking-wide text-muted">About</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-text2">{coach.bio}</p>
          </div>
        )}

        {/* Request review CTA */}
        <div className="rounded-2xl border border-line bg-surface p-5">
          {reviewSent ? (
            <div className="py-2 text-center">
              <p className="text-sm font-medium text-kiwi">✓ Review request sent</p>
              <p className="mt-1 text-xs text-muted">
                {coach.display_name || 'The coach'} will be notified and will leave feedback on your clip.
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-text">Get feedback from {coach.display_name || 'this coach'}</p>
                <p className="mt-0.5 text-sm text-text3">
                  {coach.credit_rate
                    ? `${coach.credit_rate} credits per clip review`
                    : 'Credit rate not set'}
                </p>
              </div>
              <Button onClick={() => setShowReviewModal(true)} disabled={!coach.credit_rate}>
                Request review
              </Button>
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
    </AppLayout>
  )
}
