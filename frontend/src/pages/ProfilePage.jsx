import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useApi } from '../api/client'
import { useCurrentUser } from '../hooks/useCurrentUser'
import AppLayout from '../components/AppLayout'
import Button from '../components/Button'
import Tag from '../components/Tag'
import CoachProfileForm from '../components/CoachProfileForm'

const EXPERIENCE_LEVELS = [
  { value: 'beginner',     label: 'Beginner' },
  { value: 'intermediate', label: 'Intermediate' },
  { value: 'advanced',     label: 'Advanced' },
  { value: 'pro',          label: 'Pro' },
]

const TIER_LABELS = { free: 'Free', pro: 'Pro', elite: 'Elite' }

export default function ProfilePage() {
  const api = useApi()
  const navigate = useNavigate()
  const { user, refetch } = useCurrentUser()
  const [experience, setExperience] = useState('intermediate')
  const [consentBusy, setConsentBusy] = useState(false)

  useEffect(() => {
    if (user?.experience_level) setExperience(user.experience_level)
  }, [user?.experience_level])

  async function handleExperience(value) {
    setExperience(value)
    try {
      await api.patch('/users/me', { experience_level: value })
      refetch()
    } catch {}
  }

  async function handleConsentToggle() {
    const granting = !user?.biometric_consent_at
    if (!granting && !window.confirm(
      'Revoking deletes the identity data we\'ve stored for you (body proportions used to recognize you in your clips). You\'ll pick your fighter manually from now on. Continue?'
    )) return
    setConsentBusy(true)
    try {
      await api.post('/users/me/consent', { granted: granting })
      refetch()
    } catch {} finally {
      setConsentBusy(false)
    }
  }

  const tier = user?.subscription_tier || 'free'

  return (
    <AppLayout active="profile">
      <main className="mx-auto max-w-2xl px-4 py-10 md:px-8">
        <h1 className="mb-8 font-display text-[32px] font-extrabold leading-none text-text">Profile</h1>

        {/* ── Training level ── */}
        <section className="mb-10">
          <h2 className="mb-1 font-display text-lg font-extrabold uppercase tracking-wide text-text">Training level</h2>
          <p className="mb-4 text-xs text-muted">Tunes the tone and standards of your AI coaching feedback.</p>
          <div className="flex flex-wrap gap-2">
            {EXPERIENCE_LEVELS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleExperience(opt.value)}
                className={`chip ${experience === opt.value ? 'active' : ''}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        {/* ── Plan & billing ── */}
        <section className="mb-10">
          <h2 className="mb-4 font-display text-lg font-extrabold uppercase tracking-wide text-text">Plan &amp; billing</h2>
          <div className="flex items-center justify-between rounded-2xl border border-line bg-surface p-5">
            <div className="flex items-center gap-3">
              <Tag tone={tier === 'elite' ? 'gold' : tier === 'pro' ? 'success' : 'muted'}>{TIER_LABELS[tier]}</Tag>
              <div>
                <p className="text-sm font-medium text-text">{TIER_LABELS[tier]} plan</p>
                <p className="mt-0.5 text-xs text-muted">
                  {user ? `${user.credits_balance} credits available` : '—'}
                </p>
              </div>
            </div>
            <Button variant={tier === 'free' ? 'primary' : 'outline'} size="sm" onClick={() => navigate('/pricing')}>
              {tier === 'free' ? 'Upgrade' : 'Manage plan'}
            </Button>
          </div>
        </section>

        {/* ── Privacy ── */}
        <section className="mb-10">
          <h2 className="mb-1 font-display text-lg font-extrabold uppercase tracking-wide text-text">Privacy</h2>
          <p className="mb-4 text-xs text-muted">Control how Southpaw uses your biometric (pose) data.</p>
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-surface p-5">
            <div>
              <p className="text-sm font-medium text-text">Recognize me in my own clips</p>
              <p className="mt-0.5 max-w-md text-xs leading-relaxed text-muted">
                Stores your body proportions so we can automatically pick you out when other
                people are in frame. Never stored for anyone else in your videos; deleted
                immediately if you turn this off.
              </p>
            </div>
            <Button
              variant={user?.biometric_consent_at ? 'outline' : 'primary'}
              size="sm"
              onClick={handleConsentToggle}
              disabled={consentBusy || !user}
            >
              {consentBusy ? '...' : user?.biometric_consent_at ? 'Revoke' : 'Enable'}
            </Button>
          </div>
        </section>

        {/* ── Coach profile (coaches only) ── */}
        {user?.user_type === 'coach' && (
          <section className="mb-10">
            <h2 className="mb-1 font-display text-lg font-extrabold uppercase tracking-wide text-text">Coach profile</h2>
            <p className="mb-4 text-xs text-muted">Your public marketplace listing, media, and payouts.</p>
            <CoachProfileForm />
          </section>
        )}

        {/* ── Admin ── */}
        {user?.is_admin && (
          <section className="mb-10">
            <h2 className="mb-4 font-display text-lg font-extrabold uppercase tracking-wide text-text">Admin</h2>
            <button
              onClick={() => navigate('/admin')}
              className="text-sm font-display font-bold uppercase tracking-wide text-warning transition-colors hover:text-kiwi"
            >
              Coach moderation →
            </button>
          </section>
        )}
      </main>
    </AppLayout>
  )
}
