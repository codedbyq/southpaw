import { useState, useEffect } from 'react'
import { useApi } from '../api/client'
import Button from './Button'
import { CoachProfileSkeleton } from './Skeleton'

const SPECIALIZATION_OPTIONS = [
  { value: 'boxing',     label: 'Boxing' },
  { value: 'muay_thai',  label: 'Muay Thai' },
  { value: 'mma',        label: 'MMA' },
  { value: 'kickboxing', label: 'Kickboxing' },
  { value: 'wrestling',  label: 'Wrestling' },
  { value: 'bjj',        label: 'BJJ' },
  { value: 'judo',       label: 'Judo' },
  { value: 'southpaw',   label: 'Southpaw' },
  { value: 'clinch',     label: 'Clinch work' },
  { value: 'footwork',   label: 'Footwork' },
]

/**
 * Coach profile editor — extracted from the old CoachProfilePage so it can be
 * embedded inside the unified ProfilePage. No layout wrapper; the host page
 * provides AppLayout, headings, and surrounding chrome.
 */
export default function CoachProfileForm() {
  const api = useApi()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [isNew, setIsNew] = useState(false)

  // Stripe Connect
  const [connectStatus, setConnectStatus] = useState(null)
  const [connectLoading, setConnectLoading] = useState(false)
  const [payoutLoading, setPayoutLoading] = useState(false)
  const [payoutResult, setPayoutResult] = useState(null)

  const [displayName, setDisplayName] = useState('')
  const [bio, setBio] = useState('')
  const [specializations, setSpecializations] = useState([])
  const [creditRate, setCreditRate] = useState('')
  const [reviewPreference, setReviewPreference] = useState('either')

  // Media
  const [avatarUrl, setAvatarUrl] = useState(null)
  const [introVideoUrl, setIntroVideoUrl] = useState(null)
  const [introThumbUrl, setIntroThumbUrl] = useState(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [videoUploading, setVideoUploading] = useState(false)
  const [mediaError, setMediaError] = useState(null)

  useEffect(() => {
    async function load() {
      try {
        const profile = await api.get('/coaches/me/profile')
        setDisplayName(profile.display_name || '')
        setBio(profile.bio || '')
        setSpecializations(profile.specializations || [])
        setCreditRate(profile.credit_rate?.toString() || '')
        setReviewPreference(profile.review_preference || 'either')
        setAvatarUrl(profile.avatar_url || null)
        setIntroVideoUrl(profile.intro_video_url || null)
        setIntroThumbUrl(profile.intro_video_thumb_url || null)
      } catch (err) {
        if (err.message === 'Coach profile not found') {
          setIsNew(true)
        } else {
          setError(err.message)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Load Connect status + handle return from Stripe onboarding
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const connect = params.get('connect')
    if (connect) window.history.replaceState({}, '', '/profile')

    api.get('/payments/connect/status')
      .then(setConnectStatus)
      .catch(() => {})
  }, [])

  async function handleConnectOnboard() {
    setConnectLoading(true)
    try {
      const { onboarding_url } = await api.post('/payments/connect/onboard', {})
      window.location.href = onboarding_url
    } catch (err) {
      setError(err.message)
      setConnectLoading(false)
    }
  }

  async function handlePayout() {
    setPayoutLoading(true)
    try {
      const result = await api.post('/payments/connect/payout', {})
      setPayoutResult(result)
      setConnectStatus(prev => prev ? { ...prev, credits_balance: 0, can_payout: false } : prev)
    } catch (err) {
      setError(err.message)
    } finally {
      setPayoutLoading(false)
    }
  }

  async function handleMediaUpload(file, mediaType) {
    setMediaError(null)
    const setUploading = mediaType === 'avatar' ? setAvatarUploading : setVideoUploading

    if (mediaType === 'intro_video' && file.size > 50 * 1024 * 1024) {
      setMediaError('Intro video must be under 50MB')
      return
    }

    setUploading(true)
    try {
      const { upload_url, s3_key } = await api.post('/coaches/me/media-url', {
        media_type: mediaType,
        filename: file.name,
        content_type: file.type,
      })

      await fetch(upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } })

      await api.post('/coaches/me/media-url/complete', { media_type: mediaType, s3_key })

      // Show local preview immediately
      const localUrl = URL.createObjectURL(file)
      if (mediaType === 'avatar') {
        setAvatarUrl(localUrl)
      } else {
        setIntroVideoUrl(localUrl)
        // Poll for thumbnail — Modal inference extracts it asynchronously
        setTimeout(async () => {
          try {
            const updated = await api.get('/coaches/me/profile')
            if (updated.intro_video_thumb_url) setIntroThumbUrl(updated.intro_video_thumb_url)
          } catch (e) { console.error('Thumbnail poll failed', e) }
        }, 5000)
      }
    } catch (err) {
      setMediaError(err.message)
    } finally {
      setUploading(false)
    }
  }

  function toggleSpec(value) {
    setSpecializations(prev =>
      prev.includes(value) ? prev.filter(s => s !== value) : [...prev, value]
    )
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)

    const body = {
      display_name: displayName || null,
      bio: bio || null,
      specializations,
      credit_rate: creditRate ? parseInt(creditRate) : null,
      review_preference: reviewPreference,
    }

    try {
      if (isNew) {
        await api.post('/coaches/me/profile', body)
        setIsNew(false)
      } else {
        await api.patch('/coaches/me/profile', body)
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <CoachProfileSkeleton />

  return (
    <form onSubmit={handleSave} className="space-y-8">
      {/* Status banner for new profiles */}
      {isNew && (
        <div className="p-4 bg-kiwi/8 border border-kiwi/40 rounded-xl text-sm text-text2">
          Set up your coach profile. Once submitted it will be reviewed before appearing in the marketplace.
        </div>
      )}

      {/* Media — only shown after profile exists */}
      {!isNew && (
        <div className="space-y-6">
          {/* Avatar */}
          <div>
            <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-3">Profile photo</label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-surface3 border-2 border-kiwi flex items-center justify-center overflow-hidden flex-shrink-0">
                {avatarUrl
                  ? <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                  : <span className="text-2xl">🎯</span>
                }
              </div>
              <label className={`btn btn-secondary text-[13px] px-4 py-2 cursor-pointer ${avatarUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                {avatarUploading ? 'Uploading...' : 'Upload photo'}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  className="hidden"
                  disabled={avatarUploading}
                  onChange={e => e.target.files?.[0] && handleMediaUpload(e.target.files[0], 'avatar')}
                />
              </label>
              <span className="text-xs text-muted">JPEG, PNG or WebP</span>
            </div>
          </div>

          {/* Intro video */}
          <div>
            <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-1">Intro video</label>
            <p className="text-xs text-muted mb-3">60-90 seconds — tell fighters about your coaching style</p>
            {introThumbUrl || introVideoUrl ? (
              <div className="flex items-center gap-4">
                <div className="w-24 h-16 rounded-lg bg-surface3 overflow-hidden flex-shrink-0">
                  {introThumbUrl
                    ? <img src={introThumbUrl} alt="Intro" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-muted text-xs">Video</div>
                  }
                </div>
                <label className={`btn btn-secondary text-[13px] px-4 py-2 cursor-pointer ${videoUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                  {videoUploading ? 'Uploading...' : 'Replace video'}
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime"
                    className="hidden"
                    disabled={videoUploading}
                    onChange={e => e.target.files?.[0] && handleMediaUpload(e.target.files[0], 'intro_video')}
                  />
                </label>
              </div>
            ) : (
              <label className={`btn btn-secondary text-[13px] px-4 py-2 cursor-pointer ${videoUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                {videoUploading ? 'Uploading...' : 'Upload intro video'}
                <input
                  type="file"
                  accept="video/mp4,video/quicktime"
                  className="hidden"
                  disabled={videoUploading}
                  onChange={e => e.target.files?.[0] && handleMediaUpload(e.target.files[0], 'intro_video')}
                />
              </label>
            )}
            <p className="text-xs text-muted mt-2">Max 50MB · MP4 or MOV</p>
          </div>

          {mediaError && <p className="text-danger text-sm">{mediaError}</p>}
        </div>
      )}

      {/* Display name */}
      <div>
        <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-2">Display name</label>
        <input
          type="text"
          value={displayName}
          onChange={e => setDisplayName(e.target.value)}
          placeholder="How you'll appear in the marketplace"
          className="input"
        />
      </div>

      {/* Bio */}
      <div>
        <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-2">Bio</label>
        <textarea
          value={bio}
          onChange={e => setBio(e.target.value)}
          placeholder="Tell fighters about your background, coaching style, and experience..."
          rows={4}
          className="input resize-none"
        />
      </div>

      {/* Specializations */}
      <div>
        <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-3">Specializations</label>
        <div className="flex flex-wrap gap-2">
          {SPECIALIZATION_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggleSpec(opt.value)}
              className={`chip ${specializations.includes(opt.value) ? 'active' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Credit rate */}
      <div>
        <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-2">
          Credit rate per clip review
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min="1"
            max="500"
            value={creditRate}
            onChange={e => setCreditRate(e.target.value)}
            placeholder="e.g. 10"
            className="input w-32"
          />
          <span className="text-sm text-muted">credits per review</span>
        </div>
        <p className="text-xs text-muted mt-2">
          Athletes spend credits to request your review. You earn 80% — Southpaw keeps 20%.
        </p>
      </div>

      {/* Review preference */}
      <div>
        <label className="block text-sm font-display font-bold uppercase tracking-wide text-text mb-2">Review preference</label>
        <div className="flex gap-3">
          {[
            { value: 'clip', label: 'Clip', desc: 'Individual rounds' },
            { value: 'session', label: 'Session', desc: 'Full training day' },
            { value: 'either', label: 'Either', desc: 'No preference' },
          ].map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setReviewPreference(opt.value)}
              className={`flex-1 p-3 rounded-xl border text-left transition-all ${
                reviewPreference === opt.value
                  ? 'border-kiwi bg-kiwi/8'
                  : 'border-line hover:border-line2'
              }`}
            >
              <p className="text-sm font-medium text-text">{opt.label}</p>
              <p className="text-xs text-muted mt-0.5">{opt.desc}</p>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted mt-2">
          This is shown to athletes on your marketplace profile so they know what to submit.
        </p>
      </div>

      {/* Stripe Connect payouts */}
      {!isNew && connectStatus && (
        <div className="p-4 bg-surface border border-line rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text">Payouts</p>
              <p className="text-xs text-muted mt-0.5">
                {connectStatus.stripe_connected
                  ? connectStatus.payouts_enabled
                    ? `${connectStatus.credits_balance} credits available · $${connectStatus.payout_value_dollars.toFixed(2)}`
                    : 'Complete onboarding to enable payouts'
                  : 'Connect your bank account to receive payouts'}
              </p>
            </div>

            {!connectStatus.stripe_connected || !connectStatus.payouts_enabled ? (
              <Button size="sm" type="button" onClick={handleConnectOnboard} disabled={connectLoading}>
                {connectLoading ? 'Redirecting...' : connectStatus.stripe_connected ? 'Complete setup' : 'Set up payouts'}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                type="button"
                onClick={handlePayout}
                disabled={!connectStatus.can_payout || payoutLoading}
                title={!connectStatus.can_payout ? `Minimum ${connectStatus.minimum_payout_credits} credits needed` : ''}
              >
                {payoutLoading ? 'Processing...' : `Cash out $${connectStatus.payout_value_dollars.toFixed(2)}`}
              </Button>
            )}
          </div>

          {payoutResult && (
            <p className="text-xs text-kiwi">
              ✓ ${payoutResult.amount_dollars.toFixed(2)} sent to your bank ({payoutResult.credits_paid} credits)
            </p>
          )}

          {connectStatus.payouts_enabled && !connectStatus.can_payout && (
            <p className="text-xs text-muted">
              Minimum payout is {connectStatus.minimum_payout_credits} credits (${(connectStatus.minimum_payout_credits * 0.25).toFixed(2)})
            </p>
          )}
        </div>
      )}

      {/* Moderation note */}
      <div className="p-4 bg-surface border border-line rounded-2xl text-sm text-text3">
        🔍 Profiles are reviewed before appearing in the marketplace. You can update your profile at any time.
      </div>

      {error && <p className="text-danger text-sm">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving} className="rounded-xl">
          {saving ? 'Saving...' : isNew ? 'Submit profile' : 'Save changes'}
        </Button>
        {saved && <span className="text-sm text-kiwi">✓ Saved</span>}
      </div>
    </form>
  )
}
