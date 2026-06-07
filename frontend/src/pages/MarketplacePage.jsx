import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
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

function CoachCard({ coach }) {
  const navigate = useNavigate()

  return (
    <div
      onClick={() => navigate(`/coaches/${coach.id}`)}
      className="flex cursor-pointer flex-col gap-4 rounded-2xl border border-line bg-surface p-5 transition-all hover:border-line2 sm:flex-row"
    >
      <div className="flex min-w-0 flex-1 gap-4">
        {/* Avatar with lime ring */}
        <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-kiwi bg-surface3 text-2xl">
          {coach.avatar_url
            ? <img src={coach.avatar_url} alt={coach.display_name} className="h-full w-full object-cover" />
            : '🎯'
          }
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-2">
            <h3 className="truncate font-display text-xl font-extrabold tracking-tight text-text">
              {coach.display_name || 'Coach'}
            </h3>
            {coach.is_featured && <Tag tone="success">Featured</Tag>}
          </div>

          {coach.bio && (
            <p className="mb-3 line-clamp-2 text-sm text-text3">{coach.bio}</p>
          )}

          {/* Specializations */}
          {coach.specializations?.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {coach.specializations.map(s => (
                <Tag key={s} tone="spar">{SPECIALIZATION_LABELS[s] || s}</Tag>
              ))}
            </div>
          )}

          {/* Stats row */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
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
              <span>
                ~{coach.avg_response_hours < 24
                  ? `${Math.round(coach.avg_response_hours)}h`
                  : `${Math.round(coach.avg_response_hours / 24)}d`} response
              </span>
            )}
            {coach.review_preference && coach.review_preference !== 'either' && (
              <span>Prefers {coach.review_preference} reviews</span>
            )}
            {coach.credit_rate && (
              <span className="font-display font-bold text-kiwi">
                {coach.credit_rate} cr / review
              </span>
            )}
          </div>
        </div>
      </div>

      <Button size="sm" className="w-full flex-shrink-0 sm:w-auto sm:self-start" onClick={e => { e.stopPropagation(); navigate(`/coaches/${coach.id}`) }}>
        Book
      </Button>
    </div>
  )
}

export default function MarketplacePage() {
  const api = useApi()
  const navigate = useNavigate()
  const [coaches, setCoaches] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedSpec, setSelectedSpec] = useState(null)
  const [search, setSearch] = useState('')

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

  const searchLower = search.trim().toLowerCase()
  const filtered = coaches.filter(c => {
    if (selectedSpec && !c.specializations?.includes(selectedSpec)) return false
    if (!searchLower) return true
    const hay = `${c.display_name || ''} ${c.bio || ''} ${(c.specializations || []).map(s => SPECIALIZATION_LABELS[s] || s).join(' ')}`.toLowerCase()
    return hay.includes(searchLower)
  })

  return (
    <AppLayout active="marketplace">
      <div className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        {/* Header */}
        <div className="mb-8">
          <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Coach marketplace</p>
          <h1 className="mt-1 font-display text-[36px] font-extrabold leading-none text-text">Find a coach</h1>
          <p className="mt-2 text-sm text-text3">
            Get timestamped feedback on your clips from world-class coaches. Pay in credits.
          </p>
        </div>

        {loading ? (
          <div className="flex flex-col gap-4">
            {[...Array(3)].map((_, i) => <CoachCardSkeleton key={i} />)}
          </div>
        ) : coaches.length === 0 ? (
          <div className="py-20 text-center">
            <p className="text-sm text-muted">No coaches available yet.</p>
            <p className="mt-1 text-xs text-muted">Check back soon.</p>
          </div>
        ) : (
          <>
            {/* Search */}
            {coaches.length > 3 && (
              <div className="relative mb-4">
                <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search coaches by name, style or bio..."
                  className="input pl-9"
                />
                {search && (
                  <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text">×</button>
                )}
              </div>
            )}

            {/* Specialization filter */}
            {allSpecs.length > 0 && (
              <div className="mb-6 flex flex-wrap gap-2">
                <button
                  onClick={() => setSelectedSpec(null)}
                  className={`chip ${selectedSpec === null ? 'active' : ''}`}
                >
                  All
                </button>
                {allSpecs.map(s => (
                  <button
                    key={s}
                    onClick={() => setSelectedSpec(s === selectedSpec ? null : s)}
                    className={`chip ${selectedSpec === s ? 'active' : ''}`}
                  >
                    {SPECIALIZATION_LABELS[s] || s}
                  </button>
                ))}
              </div>
            )}

            {/* Coach list */}
            <div className="flex flex-col gap-3">
              {filtered.map(coach => (
                <CoachCard key={coach.id} coach={coach} />
              ))}
            </div>

            {filtered.length === 0 && (
              <p className="py-10 text-center text-sm text-muted">
                No coaches match your search.
              </p>
            )}
          </>
        )}
      </div>
    </AppLayout>
  )
}
