import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'
import { CoachProfileSkeleton } from '../components/Skeleton'

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

export default function CoachProfilePage() {
  const api = useApi()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
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
    if (connect) window.history.replaceState({}, '', '/coach/profile')

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
        // Poll for thumbnail — Celery extracts it asynchronously
        setTimeout(async () => {
          try {
            const updated = await api.get('/coaches/me/profile')
            console.log('Profile after thumbnail poll:', updated)
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
      navigate('/dashboard')
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button
          onClick={() => navigate('/dashboard')}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          ← Dashboard
        </button>
        <span className="font-bold text-lg tracking-tight">Coach profile</span>
        <UserButton />
      </nav>

      <main className="max-w-2xl mx-auto px-6 py-12">
        {loading ? (
          <CoachProfileSkeleton />
        ) : (
          <form onSubmit={handleSave} className="space-y-8">

            {/* Status banner for new profiles */}
            {isNew && (
              <div className="p-4 bg-indigo-950 border border-indigo-800 rounded-xl text-sm text-indigo-300">
                Set up your coach profile. Once submitted it will be reviewed before appearing in the marketplace.
              </div>
            )}

            {/* Media — only shown after profile exists */}
            {!isNew && (
              <div className="space-y-6">
                {/* Avatar */}
                <div>
                  <label className="block text-sm font-medium text-white mb-3">Profile photo</label>
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center overflow-hidden flex-shrink-0">
                      {avatarUrl
                        ? <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                        : <span className="text-2xl">🎯</span>
                      }
                    </div>
                    <label className={`cursor-pointer px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors ${avatarUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      {avatarUploading ? 'Uploading...' : 'Upload photo'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={avatarUploading}
                        onChange={e => e.target.files?.[0] && handleMediaUpload(e.target.files[0], 'avatar')}
                      />
                    </label>
                    <span className="text-xs text-gray-600">JPEG, PNG or WebP</span>
                  </div>
                </div>

                {/* Intro video */}
                <div>
                  <label className="block text-sm font-medium text-white mb-1">Intro video</label>
                  <p className="text-xs text-gray-500 mb-3">60-90 seconds — tell fighters about your coaching style</p>
                  {introThumbUrl || introVideoUrl ? (
                    <div className="flex items-center gap-4">
                      <div className="w-24 h-16 rounded-lg bg-gray-800 overflow-hidden flex-shrink-0">
                        {introThumbUrl
                          ? <img src={introThumbUrl} alt="Intro" className="w-full h-full object-cover" />
                          : <div className="w-full h-full flex items-center justify-center text-gray-500 text-xs">Video</div>
                        }
                      </div>
                      <label className={`cursor-pointer px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors ${videoUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
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
                    <label className={`inline-block cursor-pointer px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors ${videoUploading ? 'opacity-50 cursor-not-allowed' : ''}`}>
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
                  <p className="text-xs text-gray-600 mt-2">Max 50MB · MP4 or MOV</p>
                </div>

                {mediaError && <p className="text-red-400 text-sm">{mediaError}</p>}
              </div>
            )}

            {/* Display name */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Display name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="How you'll appear in the marketplace"
                className="w-full px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-xl text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              />
            </div>

            {/* Bio */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Bio</label>
              <textarea
                value={bio}
                onChange={e => setBio(e.target.value)}
                placeholder="Tell fighters about your background, coaching style, and experience..."
                rows={4}
                className="w-full px-4 py-3 bg-gray-900 border border-gray-700 rounded-xl text-white text-sm placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none"
              />
            </div>

            {/* Specializations */}
            <div>
              <label className="block text-sm font-medium text-white mb-3">Specializations</label>
              <div className="flex flex-wrap gap-2">
                {SPECIALIZATION_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => toggleSpec(opt.value)}
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      specializations.includes(opt.value)
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-800 text-gray-400 hover:text-white'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Credit rate */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">
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
                  className="w-32 px-4 py-2.5 bg-gray-900 border border-gray-700 rounded-xl text-white text-sm focus:outline-none focus:border-indigo-500"
                />
                <span className="text-sm text-gray-500">credits per review</span>
              </div>
              <p className="text-xs text-gray-600 mt-2">
                Athletes spend credits to request your review. You earn 80% — Southpaw keeps 20%.
              </p>
            </div>

            {/* Review preference */}
            <div>
              <label className="block text-sm font-medium text-white mb-2">Review preference</label>
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
                        ? 'border-indigo-500 bg-indigo-950'
                        : 'border-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <p className="text-sm font-medium text-white">{opt.label}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{opt.desc}</p>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-600 mt-2">
                This is shown to athletes on your marketplace profile so they know what to submit.
              </p>
            </div>

            {/* Stripe Connect payouts */}
            {!isNew && connectStatus && (
              <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-white">Payouts</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {connectStatus.stripe_connected
                        ? connectStatus.payouts_enabled
                          ? `${connectStatus.credits_balance} credits available · $${connectStatus.payout_value_dollars.toFixed(2)}`
                          : 'Complete onboarding to enable payouts'
                        : 'Connect your bank account to receive payouts'}
                    </p>
                  </div>

                  {!connectStatus.stripe_connected || !connectStatus.payouts_enabled ? (
                    <button
                      type="button"
                      onClick={handleConnectOnboard}
                      disabled={connectLoading}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      {connectLoading ? 'Redirecting...' : connectStatus.stripe_connected ? 'Complete setup' : 'Set up payouts'}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={handlePayout}
                      disabled={!connectStatus.can_payout || payoutLoading}
                      className="px-4 py-2 bg-green-700 hover:bg-green-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
                      title={!connectStatus.can_payout ? `Minimum ${connectStatus.minimum_payout_credits} credits needed` : ''}
                    >
                      {payoutLoading ? 'Processing...' : `Cash out $${connectStatus.payout_value_dollars.toFixed(2)}`}
                    </button>
                  )}
                </div>

                {payoutResult && (
                  <p className="text-xs text-green-400">
                    ✓ ${payoutResult.amount_dollars.toFixed(2)} sent to your bank ({payoutResult.credits_paid} credits)
                  </p>
                )}

                {connectStatus.payouts_enabled && !connectStatus.can_payout && (
                  <p className="text-xs text-gray-600">
                    Minimum payout is {connectStatus.minimum_payout_credits} credits (${(connectStatus.minimum_payout_credits * 0.25).toFixed(2)})
                  </p>
                )}
              </div>
            )}

            {/* Moderation note */}
            <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm text-gray-400">
              🔍 Profiles are reviewed before appearing in the marketplace. You can update your profile at any time.
            </div>

            {error && (
              <p className="text-red-400 text-sm">{error}</p>
            )}

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={saving}
                className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium rounded-xl transition-colors"
              >
                {saving ? 'Saving...' : isNew ? 'Submit profile' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={() => navigate('/dashboard')}
                className="px-6 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors"
              >
                Cancel
              </button>
            </div>

          </form>
        )}
      </main>
    </div>
  )
}
