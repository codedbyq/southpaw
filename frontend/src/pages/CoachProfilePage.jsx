import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'

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

  const [bio, setBio] = useState('')
  const [specializations, setSpecializations] = useState([])
  const [creditRate, setCreditRate] = useState('')

  useEffect(() => {
    async function load() {
      try {
        const profile = await api.get('/coaches/me/profile')
        setBio(profile.bio || '')
        setSpecializations(profile.specializations || [])
        setCreditRate(profile.credit_rate?.toString() || '')
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
      bio: bio || null,
      specializations,
      credit_rate: creditRate ? parseInt(creditRate) : null,
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
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : (
          <form onSubmit={handleSave} className="space-y-8">

            {/* Status banner for new profiles */}
            {isNew && (
              <div className="p-4 bg-indigo-950 border border-indigo-800 rounded-xl text-sm text-indigo-300">
                Set up your coach profile. Once submitted it will be reviewed before appearing in the marketplace.
              </div>
            )}

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
