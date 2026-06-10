import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'

const OPTIONS = [
  {
    value: 'athlete',
    label: 'Athlete',
    description: 'I train and want to analyse my own footage and track progress.',
    icon: '🥊',
  },
  {
    value: 'coach',
    label: 'Coach',
    description: 'I coach fighters and want to review clips and track athletes. (Includes athlete tools)',
    icon: '🎯',
  },
]

export default function OnboardingPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [selected, setSelected] = useState(null)
  const [consent, setConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleContinue() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      await api.patch('/users/me', { user_type: selected })
      if (consent) {
        // Optional — everything works without it, identity memory stays off
        try { await api.post('/users/me/consent', { granted: true }) } catch {}
      }
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError('Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-ink flex items-center justify-center px-4">
      <div className="w-full max-w-lg">

        {/* Header */}
        <div className="text-center mb-10">
          <p className="font-display text-2xl font-black uppercase tracking-tighter text-kiwi mb-4">Southpaw</p>
          <h1 className="font-display text-[32px] font-extrabold uppercase tracking-wide text-text mb-2">Welcome</h1>
          <p className="text-text3">How will you be using the platform?</p>
        </div>

        {/* Options */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setSelected(option.value)}
              className={`flex flex-col items-center text-center p-8 rounded-2xl border transition-all h-56 ${
                selected === option.value
                  ? 'border-kiwi bg-kiwi/8'
                  : 'border-line bg-surface hover:border-line2'
              }`}
            >
              <span className="text-4xl mb-4">{option.icon}</span>
              <p className="font-display font-extrabold uppercase tracking-wide text-text text-lg mb-2">{option.label}</p>
              <p className="text-sm text-text3 leading-relaxed">{option.description}</p>
            </button>
          ))}
        </div>

        {/* Biometric consent — optional, plain English */}
        <label className="mb-8 flex cursor-pointer items-start gap-3 rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line2">
          <input
            type="checkbox"
            checked={consent}
            onChange={e => setConsent(e.target.checked)}
            className="mt-0.5 rounded accent-kiwi"
          />
          <span className="text-xs leading-relaxed text-text3">
            <span className="font-semibold text-text">Let Southpaw recognize me in my own clips.</span>{' '}
            Our analysis maps your body's movement (pose keypoints), which counts as biometric
            data. With your consent we also store your body proportions so we can automatically
            pick you out when other people are in frame. We never store this for anyone else in
            your videos, and it's deleted if you revoke consent (in Profile) or delete your
            account. Leave this unchecked and everything still works — you'll just confirm
            which fighter is you manually.
          </span>
        </label>

        {/* Error */}
        {error && (
          <p className="text-danger text-sm text-center mb-4">{error}</p>
        )}

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={!selected || saving}
          className="btn btn-primary w-full py-3 rounded-xl"
        >
          {saving ? 'Saving...' : 'Continue'}
        </button>

      </div>
    </div>
  )
}
