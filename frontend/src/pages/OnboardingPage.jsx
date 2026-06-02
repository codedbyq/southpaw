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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  async function handleContinue() {
    if (!selected) return
    setSaving(true)
    setError(null)
    try {
      await api.patch('/users/me', { user_type: selected })
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError('Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-black flex items-center justify-center px-4">
      <div className="w-full max-w-lg">

        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-white mb-2">Welcome to Southpaw</h1>
          <p className="text-gray-400">How will you be using the platform?</p>
        </div>

        {/* Options */}
        <div className="grid grid-cols-2 gap-4 mb-8">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setSelected(option.value)}
              className={`flex flex-col items-center text-center p-8 rounded-xl border transition-all h-56 ${
                selected === option.value
                  ? 'border-indigo-500 bg-indigo-950'
                  : 'border-gray-800 bg-gray-900 hover:border-gray-600'
              }`}
            >
              <span className="text-4xl mb-4">{option.icon}</span>
              <p className="font-semibold text-white text-lg mb-2">{option.label}</p>
              <p className="text-sm text-gray-400 leading-relaxed">{option.description}</p>
            </button>
          ))}
        </div>

        {/* Error */}
        {error && (
          <p className="text-red-400 text-sm text-center mb-4">{error}</p>
        )}

        {/* Continue button */}
        <button
          onClick={handleContinue}
          disabled={!selected || saving}
          className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving...' : 'Continue'}
        </button>

      </div>
    </div>
  )
}
