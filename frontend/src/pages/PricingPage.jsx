import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { UserButton } from '@clerk/react'
import { useApi } from '../api/client'

const FEATURE_ICONS = { '✓': true }

export default function PricingPage() {
  const api = useApi()
  const navigate = useNavigate()
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('subscription') === 'cancelled') {
      window.history.replaceState({}, '', '/pricing')
    }
    api.get('/users/me').then(setCurrentUser).catch(() => {})
  }, [])

  async function handleSubscribe(plan) {
    if (plan === 'free') return
    setLoading(plan)
    setError(null)
    try {
      const { checkout_url } = await api.post('/payments/subscribe', { pack: plan })
      window.location.href = checkout_url
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  async function handleManage() {
    setLoading('manage')
    try {
      const { portal_url } = await api.post('/payments/portal', {})
      window.location.href = portal_url
    } catch (err) {
      setError(err.message)
      setLoading(false)
    }
  }

  const currentTier = currentUser?.subscription_tier || 'free'

  const tiers = [
    {
      id: 'free',
      name: 'Free',
      price: '$0',
      period: 'forever',
      credits: '5 credits/month',
      features: [
        '3 clips per month',
        '5 credits / month',
        'Clip-level AI feedback',
        'Strike detection & metrics',
        'Session management',
      ],
      cta: 'Current plan',
      highlight: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '$12',
      period: '/month',
      credits: '25 credits/month',
      features: [
        'Unlimited clips',
        '25 credits / month',
        'Session & trend AI feedback',
        'Combo detection',
        'Fatigue curve analysis',
        'Coach marketplace access',
      ],
      cta: 'Upgrade to Pro',
      highlight: true,
    },
    {
      id: 'elite',
      name: 'Elite',
      price: '$29',
      period: '/month',
      credits: '75 credits/month',
      features: [
        'Everything in Pro',
        '75 credits / month',
        'Priority processing queue',
        'Advanced analytics',
        'Best credit rate (save 46%)',
      ],
      cta: 'Upgrade to Elite',
      highlight: false,
    },
  ]

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <button onClick={() => navigate('/dashboard')} className="text-sm text-gray-400 hover:text-white transition-colors">
          ← Dashboard
        </button>
        <span className="font-bold text-lg tracking-tight">Southpaw</span>
        <UserButton />
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-16">
        <div className="text-center mb-12">
          <h1 className="text-3xl font-bold text-white mb-3">Simple, transparent pricing</h1>
          <p className="text-gray-400">Credits never expire. Cancel anytime.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
          {tiers.map(tier => {
            const isCurrent = currentTier === tier.id
            const isDowngrade = (currentTier === 'elite' && tier.id === 'pro') ||
                                (currentTier !== 'free' && tier.id === 'free')

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col rounded-2xl border p-6 ${
                  tier.highlight
                    ? 'border-indigo-500 bg-indigo-950/30'
                    : 'border-gray-800 bg-gray-900'
                }`}
              >
                {tier.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="text-xs px-3 py-1 bg-indigo-600 text-white rounded-full font-medium">
                      Most popular
                    </span>
                  </div>
                )}

                <div className="mb-6">
                  <h2 className="text-lg font-bold text-white mb-1">{tier.name}</h2>
                  <div className="flex items-baseline gap-1">
                    <span className="text-3xl font-bold text-white">{tier.price}</span>
                    <span className="text-gray-500 text-sm">{tier.period}</span>
                  </div>
                  <p className="text-xs text-indigo-400 mt-1">{tier.credits}</p>
                </div>

                <ul className="space-y-2.5 mb-8 flex-1">
                  {tier.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-gray-300">
                      <span className="text-green-400 mt-0.5 flex-shrink-0">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <div className="space-y-2">
                    <div className="w-full py-2.5 bg-gray-800 text-gray-400 text-sm font-medium rounded-xl text-center">
                      Current plan
                    </div>
                    {currentTier !== 'free' && (
                      <button
                        onClick={handleManage}
                        disabled={loading === 'manage'}
                        className="w-full py-2 text-xs text-gray-500 hover:text-white transition-colors"
                      >
                        {loading === 'manage' ? 'Loading...' : 'Manage or cancel →'}
                      </button>
                    )}
                  </div>
                ) : isDowngrade ? (
                  <button
                    onClick={handleManage}
                    disabled={!!loading}
                    className="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-400 text-sm font-medium rounded-xl transition-colors disabled:opacity-50"
                  >
                    Manage plan
                  </button>
                ) : (
                  <button
                    onClick={() => handleSubscribe(tier.id)}
                    disabled={!!loading}
                    className={`w-full py-2.5 text-sm font-medium rounded-xl transition-colors disabled:opacity-50 ${
                      tier.highlight
                        ? 'bg-indigo-600 hover:bg-indigo-500 text-white'
                        : 'bg-gray-800 hover:bg-gray-700 text-white'
                    }`}
                  >
                    {loading === tier.id ? 'Redirecting...' : tier.cta}
                  </button>
                )}
              </div>
            )
          })}
        </div>

        {error && <p className="text-red-400 text-sm text-center">{error}</p>}

        <p className="text-center text-xs text-gray-600">
          Secure payment via Stripe · Credits roll over month to month · Cancel anytime from your account
        </p>
      </main>
    </div>
  )
}
