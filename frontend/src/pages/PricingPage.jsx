import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'

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
      credits: '5 credits / mo',
      features: [
        '3 clips per month',
        '5 credits / month',
        'Clip-level AI feedback',
        'Strike detection & metrics',
        'YOLOv8 nano pose estimation',
        'DeepSeek V3 AI coaching',
      ],
      cta: 'Current plan',
      highlight: false,
    },
    {
      id: 'pro',
      name: 'Pro',
      price: '$12',
      period: '/ month',
      credits: '25 credits / mo',
      features: [
        'Unlimited clips',
        '25 credits / month',
        'Session & trend AI feedback',
        'Combo detection + fatigue curve',
        'YOLOv8 small — better accuracy',
        'DeepSeek V3 AI coaching',
        'Coach marketplace access',
      ],
      cta: 'Upgrade to Pro',
      highlight: true,
    },
    {
      id: 'elite',
      name: 'Elite',
      price: '$29',
      period: '/ month',
      credits: '75 credits / mo',
      features: [
        'Everything in Pro',
        '75 credits / month',
        'YOLOv8 medium — best keypoint accuracy',
        'DeepSeek R1 reasoning model',
        'Best credit rate (save 46%)',
      ],
      cta: 'Go Elite',
      highlight: false,
    },
  ]

  return (
    <AppLayout active="pricing">
      <div className="mx-auto max-w-5xl px-8 py-16">
        <div className="mb-12 text-center">
          <p className="font-display text-[13px] font-semibold uppercase tracking-[0.13em] text-muted">Membership</p>
          <h1 className="mt-2 font-display text-[42px] font-extrabold leading-none text-text">Train like a pro</h1>
          <p className="mt-3 text-text3">Credits roll over month to month. Cancel anytime.</p>
        </div>

        <div className="mb-10 grid grid-cols-1 gap-5 md:grid-cols-3">
          {tiers.map(tier => {
            const isCurrent = currentTier === tier.id
            const isDowngrade = (currentTier === 'elite' && tier.id === 'pro') ||
                                (currentTier !== 'free' && tier.id === 'free')

            return (
              <div
                key={tier.id}
                className={`relative flex flex-col overflow-hidden rounded-[20px] border p-7 ${
                  tier.highlight
                    ? 'border-kiwi bg-surface shadow-[0_0_32px_rgba(204,255,0,0.08)]'
                    : 'border-line bg-surface'
                }`}
              >
                {tier.highlight && <span className="absolute inset-x-6 top-0 h-0.5 bg-kiwi" />}
                {tier.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="rounded-full bg-kiwi px-3.5 py-1 font-display text-xs font-extrabold uppercase tracking-wide text-black">
                      Most popular
                    </span>
                  </div>
                )}

                <div className="mb-6">
                  <h2 className="font-display text-[22px] font-extrabold uppercase tracking-wide text-text">{tier.name}</h2>
                  <div className="mt-1 flex items-baseline gap-1">
                    <span className="font-display text-5xl font-black leading-none tracking-tighter text-text">{tier.price}</span>
                    <span className="text-sm text-muted">{tier.period}</span>
                  </div>
                  <p className="mt-1.5 font-display text-sm font-bold uppercase tracking-wide text-kiwi">{tier.credits}</p>
                </div>

                <ul className="mb-7 flex flex-1 flex-col gap-3">
                  {tier.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2.5 text-sm text-text2">
                      <span className="mt-0.5 flex-shrink-0 font-bold text-kiwi">✓</span>
                      {f}
                    </li>
                  ))}
                </ul>

                {isCurrent ? (
                  <div className="space-y-2">
                    <div className="w-full rounded-xl bg-surface2 py-2.5 text-center font-display text-sm font-bold uppercase tracking-wide text-muted">
                      Current plan
                    </div>
                    {currentTier !== 'free' && (
                      <button
                        onClick={handleManage}
                        disabled={loading === 'manage'}
                        className="w-full py-2 text-xs text-muted transition-colors hover:text-text"
                      >
                        {loading === 'manage' ? 'Loading...' : 'Manage or cancel →'}
                      </button>
                    )}
                  </div>
                ) : isDowngrade ? (
                  <Button variant="secondary" onClick={handleManage} disabled={!!loading} className="w-full">
                    Manage plan
                  </Button>
                ) : (
                  <Button
                    variant={tier.highlight ? 'primary' : 'outline'}
                    onClick={() => handleSubscribe(tier.id)}
                    disabled={!!loading}
                    className="w-full"
                  >
                    {loading === tier.id ? 'Redirecting...' : tier.cta}
                  </Button>
                )}
              </div>
            )
          })}
        </div>

        {error && <p className="text-center text-sm text-danger">{error}</p>}

        <p className="text-center text-xs text-muted">
          Secure payment via Stripe · Credits roll over month to month · Cancel anytime from your account
        </p>
      </div>
    </AppLayout>
  )
}
